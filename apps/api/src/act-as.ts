import { DbLive } from '@swipeless/db'
import { MailerLive } from '@swipeless/email'
import { PhotoLinksLive } from '@swipeless/photos'
import type { ProfileId, SetupStatus } from '@swipeless/shared'
import { Cause, Effect, Layer } from 'effect'
import { DateSuggesterRules } from './date-suggester.ts'
import { FitWriterOpenAi } from './fit-writer.ts'
import { NotifierEmail } from './notifier.ts'
import { SetupLifecycle } from './setups.ts'

/**
 * A local test tool for the admin site: one person's agent picks another and
 * their human says yes, through the real `SetupLifecycle`, so the setup, the
 * date and the emails are exactly what an agent's calls would produce.
 *
 * PRODUCT.md, Trust: "the human, not the AI, says yes to every date". Acting
 * as someone breaks that, so this refuses to run in production. The admin
 * site also hides the form there and allows only the super admin.
 */

export type ActAsOutcome =
  | { readonly _tag: 'Done'; readonly status: SetupStatus }
  | { readonly _tag: 'Refused'; readonly reason: string }

const pickAndSayYes = (actorId: ProfileId, targetId: ProfileId) =>
  Effect.gen(function* () {
    const lifecycle = yield* SetupLifecycle
    const caller = { profileId: actorId }
    // Starts the setup, or joins the one the other side already started.
    const { setup } = yield* lifecycle.expressInterest(caller, targetId)
    const answer = yield* lifecycle.confirm(caller, setup.setupId)
    return { _tag: 'Done', status: answer.status } as const
  })

const ActAsLive = SetupLifecycle.Default.pipe(
  Layer.provide(PhotoLinksLive),
  Layer.provide(DateSuggesterRules),
  Layer.provide(NotifierEmail),
  Layer.provide(FitWriterOpenAi),
  Layer.provide(MailerLive),
  Layer.provide(DbLive)
)

/** Never throws. */
export const actAs = (
  actorId: string,
  targetId: string
): Promise<ActAsOutcome> =>
  process.env.NODE_ENV === 'production'
    ? Promise.resolve({ _tag: 'Refused', reason: 'not in production' })
    : Effect.runPromise(
        pickAndSayYes(actorId as ProfileId, targetId as ProfileId).pipe(
          Effect.provide(ActAsLive),
          Effect.catchAllCause((cause) =>
            Effect.succeed({
              _tag: 'Refused',
              reason: Cause.pretty(cause),
            } as const)
          )
        )
      )
