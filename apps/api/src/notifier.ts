import type { ProfileId, SetupId } from '@swipeless/shared'
import { Context, Effect, Layer } from 'effect'

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
 * No SMS provider yet, so the live adapter only logs. Ids only: a log line is
 * no place for a name or a phone number.
 */
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
