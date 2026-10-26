import { DbLive } from '@swipeless/db'
import { MailerLive } from '@swipeless/email'
import { ProfilePhotosLive } from '@swipeless/photos'
import type { ProfileId } from '@swipeless/shared'
import { Cause, Effect, Layer } from 'effect'
import { AfterResponseInline } from './after-response.ts'
import { DateSuggesterRules } from './date-suggester.ts'
import { FitWriterClaude } from './fit-writer.ts'
import { NotifierLive } from './notifier.ts'
import { Showcase, type StageOutcome } from './showcase.ts'
import { SmsLive } from './sms.ts'

/**
 * SHOWCASE ONLY: the admin site's fallback for when the timer misfires on
 * stage. The prepared match picks `targetId` and says yes now, or the date
 * request text goes again if she already has. Unlike `actAs` this runs in
 * production, but only as the configured match (SHOWCASE_MATCH_PROFILE_ID),
 * and the admin site allows only the super admin.
 */

const ShowcaseLive = Showcase.Default.pipe(
  Layer.provide(AfterResponseInline),
  Layer.provide(ProfilePhotosLive),
  Layer.provide(DateSuggesterRules),
  Layer.provide(NotifierLive),
  Layer.provide(FitWriterClaude),
  Layer.provide(MailerLive),
  Layer.provide(SmsLive),
  Layer.provide(DbLive)
)

/** Never throws. */
export const sendShowcaseRequest = (targetId: string): Promise<StageOutcome> =>
  Effect.runPromise(
    Effect.flatMap(Showcase, (showcase) =>
      showcase.stage(targetId as ProfileId)
    ).pipe(
      Effect.provide(ShowcaseLive),
      Effect.catchAllCause((cause) =>
        Effect.succeed({
          _tag: 'Refused',
          reason: Cause.pretty(cause),
        } as const)
      )
    )
  )
