import { PgDrizzle } from '@swipeless/db'
import { profiles, setups } from '@swipeless/db/schema'
import {
  type DatePlace,
  dateConfirmed,
  dateRequested,
  Mailer,
} from '@swipeless/email'
import type { ProfileId, SetupId } from '@swipeless/shared'
import { eq, inArray } from 'drizzle-orm'
import { Context, Effect, Layer } from 'effect'
import { answerPhotoUrl, answerUrl } from './answer-links.ts'
import { FitWriter } from './fit-writer.ts'
import { isOwnNumber, Sms } from './sms.ts'

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
 * The texts, in the Voice of PRODUCT.md: a short letter from a friend. They
 * carry no link: Icelandic carriers silently drop a text with one in it, so
 * the date request is answered by replying yes or no (docs/decisions.md,
 * 2026-10-26). The email keeps its links.
 *
 * Short on purpose. Icelandic letters make a text UCS-2, 67 characters a
 * segment once it splits, so the request aims at three segments and drops
 * the fit line before it grows past them.
 */
const SIGN_OFF = 'xo, swipeless'
const THREE_SEGMENTS = 3 * 67

const REYKJAVIK = 'Atlantic/Reykjavik'

/** "saturday 31 oct, 15:00", in Reykjavík time. */
export const shortWhen = (iso: string): string => {
  const at = new Date(iso)
  const day = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    timeZone: REYKJAVIK,
  }).format(at)
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: REYKJAVIK,
  }).format(at)
  return `${day}, ${time}`.toLowerCase()
}

const place = (date: DatePlace) =>
  `${shortWhen(date.time)}, ${date.venue.name}.`

/** A fit line as one clause: trimmed, ending in a full stop. */
const clause = (fit: string) => {
  const line = fit.trim()
  return /[.!?]$/.test(line) ? line : `${line}.`
}

export const dateRequestedText = (
  firstName: string,
  other: { readonly firstName: string; readonly age: number },
  date: DatePlace,
  fit: string | undefined
): string => {
  const text = (fitLine: string | undefined) =>
    [
      `hi ${firstName}. ${other.firstName}, ${other.age}, would like to meet you.`,
      ...(fitLine ? [clause(fitLine)] : []),
      place(date),
      `reply yes or no. ${SIGN_OFF}`,
    ].join(' ')
  const full = text(fit)
  return full.length <= THREE_SEGMENTS ? full : text(undefined)
}

export const dateConfirmedText = (
  otherFirstName: string,
  otherPhone: string,
  date: DatePlace
): string =>
  `it's a date. ${otherFirstName}'s number: ${otherPhone}. ${place(date)} have fun. ${SIGN_OFF}`

/** The reply to a no by text. Nobody else is told anything. */
export const declinedText = `ok, no it is. nobody is told why. ${SIGN_OFF}`

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

    /** Never to our own sending number: Twilio refuses it (21266). */
    const text = (to: string, body: string) =>
      Effect.if(isOwnNumber(to), {
        onTrue: () => Effect.logInfo('notify: not texted, our own number'),
        onFalse: () => sms.send({ to, body }),
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
          yield* text(
            self.phone,
            dateRequestedText(self.firstName, other, date, extras.fit)
          )
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
          yield* text(
            self.phone,
            dateConfirmedText(other.firstName, other.phone, date)
          )
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
