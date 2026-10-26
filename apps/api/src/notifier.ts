import { PgDrizzle } from '@swipeless/db'
import { profiles, setups } from '@swipeless/db/schema'
import {
  type DatePlace,
  dateConfirmed,
  dateRequested,
  formatDateTime,
  Mailer,
} from '@swipeless/email'
import type { ProfileId, SetupId } from '@swipeless/shared'
import { eq, inArray } from 'drizzle-orm'
import { Context, Effect, Layer } from 'effect'
import { answerPhotoUrl, answerUrl } from './answer-links.ts'
import { FitWriter } from './fit-writer.ts'
import { Sms } from './sms.ts'

/**
 * PRODUCT.md, SMS, email and small pages: "Everything after signup reaches
 * humans by SMS, email or agent reminders." This is the seam those messages
 * leave through. `SetupLifecycle` calls it after a transition has been
 * written, never before, so a message cannot announce a state the database
 * does not hold.
 *
 * Neither method can fail: a message that does not go out is not a reason to
 * undo a yes. The agent hears the same news the next time it lists setups.
 */
export class Notifier extends Context.Tag('Notifier')<
  Notifier,
  {
    /**
     * One human said yes, so the date request goes to the other: "If the
     * human says yes, the other person gets the same kind of note by SMS."
     */
    readonly dateRequested: (
      profileId: ProfileId,
      setupId: SetupId
    ) => Effect.Effect<void>
    /** Both said yes: "both get the other's phone number by SMS". */
    readonly dateConfirmed: (
      profileId: ProfileId,
      setupId: SetupId
    ) => Effect.Effect<void>
  }
>() {}

/**
 * The texts, in the Voice of PRODUCT.md: a short letter from a friend. The
 * request carries one link, to the small page that asks yes or no.
 */
const SIGN_OFF = 'xo, swipeless'

const place = (date: DatePlace) =>
  `${date.venue.name}, ${date.venue.address}\n${formatDateTime(date.time)}`

export const dateRequestedText = (
  firstName: string,
  other: { readonly firstName: string; readonly age: number },
  date: DatePlace,
  answerLink: string | undefined,
  fit: string | undefined
): string =>
  [
    `hi ${firstName}, ${other.firstName}, ${other.age}, would like to meet you.`,
    ...(fit ? [fit] : []),
    place(date),
    answerLink
      ? `yes or no? ${answerLink}`
      : 'yes or no? ask your agent about swipeless.',
    `no is always enough. ${SIGN_OFF}`,
  ].join('\n\n')

export const dateConfirmedText = (
  firstName: string,
  otherFirstName: string,
  otherPhone: string,
  date: DatePlace
): string =>
  [
    `hi ${firstName}, you and ${otherFirstName} both said yes.`,
    place(date),
    `${otherFirstName}'s number: ${otherPhone}`,
    `text them, say hi. ${SIGN_OFF}`,
  ].join('\n\n')

/**
 * Texts every person at the phone number they gave, and emails the ones who
 * also gave an address (email is optional). Log lines carry ids only: a log
 * line is no place for a name or a phone number.
 */
export const NotifierLive = Layer.effect(
  Notifier,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle
    const mailer = yield* Mailer
    const sms = yield* Sms
    const fitWriter = yield* FitWriter

    /** The setup, the person hearing the news, and the other one. */
    const load = (profileId: ProfileId, setupId: SetupId) =>
      Effect.gen(function* () {
        const [row] = yield* db
          .select({
            profileAId: setups.profileAId,
            profileBId: setups.profileBId,
            date: setups.date,
          })
          .from(setups)
          .where(eq(setups.id, setupId))
          .limit(1)
        if (row === undefined) return undefined
        const otherId =
          row.profileAId === profileId ? row.profileBId : row.profileAId
        const people = yield* db
          .select({
            id: profiles.id,
            firstName: profiles.firstName,
            email: profiles.email,
            phone: profiles.phone,
            photoUrl: profiles.photoUrl,
            brief: profiles.brief,
            age: profiles.age,
          })
          .from(profiles)
          .where(inArray(profiles.id, [profileId, otherId]))
        const self = people.find((person) => person.id === profileId)
        const other = people.find((person) => person.id === otherId)
        if (self === undefined || other === undefined) return undefined
        return { date: row.date, self, other }
      })

    type Person = {
      readonly firstName: string
      readonly age: number
      readonly photoUrl: string | null
      readonly brief: string
    }

    /**
     * The answer links, the photo and why they might click. Each is
     * optional: without a signing key or a model the email still goes,
     * pointing at the agent instead.
     */
    const requestExtras = (
      setupId: SetupId,
      profileId: ProfileId,
      self: Person,
      other: Person
    ) =>
      Effect.gen(function* () {
        const answer = yield* Effect.all({
          yes: answerUrl(setupId, profileId, 'yes'),
          no: answerUrl(setupId, profileId, 'no'),
        }).pipe(Effect.orElseSucceed(() => undefined))
        // An https photo is linked as given; a stored one goes through the
        // signed email route, which serves it while the setup is open.
        const photoUrl =
          other.photoUrl === null
            ? undefined
            : /^https:\/\//i.test(other.photoUrl)
              ? other.photoUrl
              : yield* answerPhotoUrl(setupId, profileId).pipe(
                  Effect.orElseSucceed(() => undefined)
                )
        const fit = yield* fitWriter.whyYouFit({
          forFirstName: self.firstName,
          forBrief: self.brief,
          otherFirstName: other.firstName,
          otherBrief: other.brief,
        })
        return {
          age: other.age,
          ...(answer ? { answer } : {}),
          ...(photoUrl ? { photoUrl } : {}),
          ...(fit ? { fit } : {}),
        }
      })

    const notify = (
      kind: 'date requested' | 'date confirmed',
      profileId: ProfileId,
      setupId: SetupId
    ) =>
      Effect.gen(function* () {
        const found = yield* load(profileId, setupId)
        if (found === undefined) {
          return yield* Effect.logInfo(`notify: ${kind}, no setup`)
        }
        const { date, self, other } = found
        if (kind === 'date requested') {
          const extras = yield* requestExtras(setupId, profileId, self, other)
          const link = yield* answerUrl(setupId, profileId).pipe(
            Effect.orElseSucceed(() => undefined)
          )
          yield* sms.send({
            to: self.phone,
            body: dateRequestedText(
              self.firstName,
              other,
              date,
              link,
              extras.fit
            ),
          })
          if (self.email) {
            yield* mailer.send(
              dateRequested(
                self.email,
                self.firstName,
                other.firstName,
                date,
                extras
              )
            )
          }
        } else {
          yield* sms.send({
            to: self.phone,
            body: dateConfirmedText(
              self.firstName,
              other.firstName,
              other.phone,
              date
            ),
          })
          if (self.email) {
            yield* mailer.send(
              dateConfirmed(
                self.email,
                self.firstName,
                other.firstName,
                other.phone,
                date
              )
            )
          }
        }
        yield* Effect.logInfo(
          `notify: ${kind}, texted${self.email ? ' and emailed' : ''}`
        )
      }).pipe(
        Effect.annotateLogs({ profileId, setupId }),
        Effect.catchAllCause((cause) =>
          Effect.logWarning(`notify: ${kind} failed`, cause).pipe(
            Effect.annotateLogs({ profileId, setupId })
          )
        )
      )

    return Notifier.of({
      dateRequested: (profileId, setupId) =>
        notify('date requested', profileId, setupId),
      dateConfirmed: (profileId, setupId) =>
        notify('date confirmed', profileId, setupId),
    })
  })
)

/** Logs only, for scripts like the demo seed that must never email anyone. */
export const NotifierLog = Layer.succeed(
  Notifier,
  Notifier.of({
    dateRequested: (profileId, setupId) =>
      Effect.logInfo('notify: date requested').pipe(
        Effect.annotateLogs({ profileId, setupId })
      ),
    dateConfirmed: (profileId, setupId) =>
      Effect.logInfo('notify: date confirmed').pipe(
        Effect.annotateLogs({ profileId, setupId })
      ),
  })
)
