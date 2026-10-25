import { PgDrizzle } from '@swipeless/db'
import { profiles, setups } from '@swipeless/db/schema'
import { dateConfirmed, dateRequested, Mailer } from '@swipeless/email'
import type { ProfileId, SetupId } from '@swipeless/shared'
import { eq, inArray } from 'drizzle-orm'
import { Context, Effect, Layer } from 'effect'
import { answerUrl } from './answer-links.ts'

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
 * No SMS provider yet, so the live adapter emails the people who gave an
 * address (email is optional) and logs the rest. Log lines carry ids only: a
 * log line is no place for a name or a phone number.
 */
export const NotifierEmail = Layer.effect(
  Notifier,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle
    const mailer = yield* Mailer

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
          })
          .from(profiles)
          .where(inArray(profiles.id, [profileId, otherId]))
        const self = people.find((person) => person.id === profileId)
        const other = people.find((person) => person.id === otherId)
        if (self === undefined || other === undefined) return undefined
        return { date: row.date, self, other }
      })

    const notify = (
      kind: 'date requested' | 'date confirmed',
      profileId: ProfileId,
      setupId: SetupId
    ) =>
      Effect.gen(function* () {
        const found = yield* load(profileId, setupId)
        if (found === undefined || !found.self.email) {
          return yield* Effect.logInfo(`notify: ${kind}, no email`)
        }
        const { date, self, other } = found
        const to = found.self.email
        // The small page lets them answer without their agent. Without a
        // signing key the email still goes, pointing at the agent instead.
        const answer = yield* Effect.all({
          yes: answerUrl(setupId, profileId, 'yes'),
          no: answerUrl(setupId, profileId, 'no'),
        }).pipe(Effect.orElseSucceed(() => undefined))
        yield* mailer.send(
          kind === 'date requested'
            ? dateRequested(to, self.firstName, other.firstName, date, answer)
            : dateConfirmed(
                to,
                self.firstName,
                other.firstName,
                other.phone,
                date
              )
        )
        yield* Effect.logInfo(`notify: ${kind}, emailed`)
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
