import type { ProfileId, SetupStatus } from '@swipeless/shared'
import { Config, Duration, Effect, Option } from 'effect'
import { AfterResponse } from './after-response.ts'
import { Notifier } from './notifier.ts'
import { SetupLifecycle } from './setups.ts'

/**
 * SHOWCASE ONLY, for the live demo on 2026-10-27. Off unless both
 * SHOWCASE_PHONE and SHOWCASE_MATCH_PROFILE_ID are set; see docs/decisions.md,
 * 2026-10-26.
 *
 * When a profile with SHOWCASE_PHONE publishes, a prepared match profile
 * picks it and says yes after SHOWCASE_DELAY_SECONDS, through the real
 * `SetupLifecycle`, so the date request reaches the presenter by SMS exactly
 * as a real one would. This departs from PRODUCT.md twice: the match's
 * interest is staged rather than her agent's pick, and "the human, not the
 * AI, says yes to every date" does not hold for her side.
 *
 * Config is read per call, so unsetting the variables turns it off on the
 * next request and tests can set it after the match profile exists.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The prepared match, when the showcase is on. */
export const showcaseMatchId: Effect.Effect<Option.Option<ProfileId>> =
  Config.option(Config.string('SHOWCASE_MATCH_PROFILE_ID')).pipe(
    Effect.map(Option.filter((id) => UUID.test(id.trim()))),
    Effect.map(Option.map((id) => id.trim().toLowerCase() as ProfileId)),
    Effect.orElseSucceed(() => Option.none())
  )

const showcasePhone = Config.option(Config.string('SHOWCASE_PHONE')).pipe(
  Effect.orElseSucceed(() => Option.none())
)

const delay = Config.integer('SHOWCASE_DELAY_SECONDS').pipe(
  Config.withDefault(30),
  Effect.orElseSucceed(() => 30)
)

/** Digits only, so SHOWCASE_PHONE may be written `+354 847 0454`. */
const digits = (phone: string) => phone.replace(/\D/g, '')

export type StageOutcome =
  | { readonly _tag: 'Done'; readonly status: SetupStatus }
  | { readonly _tag: 'Refused'; readonly reason: string }

export class Showcase extends Effect.Service<Showcase>()('Showcase', {
  dependencies: [SetupLifecycle.Default],
  effect: Effect.gen(function* () {
    const lifecycle = yield* SetupLifecycle
    const notifier = yield* Notifier
    const afterResponse = yield* AfterResponse

    /**
     * The match picks `targetId` and says yes, so the date request goes to
     * them. Run again on a request already sent, it sends the text again:
     * that is what the admin's fallback button is for.
     */
    const stage = (targetId: ProfileId): Effect.Effect<StageOutcome> =>
      Effect.gen(function* () {
        const matchId = yield* showcaseMatchId
        if (Option.isNone(matchId)) {
          return {
            _tag: 'Refused',
            reason: 'SHOWCASE_MATCH_PROFILE_ID is not set',
          } as const
        }
        const match = { profileId: matchId.value }
        const { setup } = yield* lifecycle.expressInterest(match, targetId)
        const alreadySent = setup.youConfirmed
        const answer = yield* lifecycle.confirm(match, setup.setupId)
        if (alreadySent && answer.status === 'requested') {
          yield* notifier.dateRequested(targetId, setup.setupId)
        }
        yield* Effect.logInfo(`showcase: date request is ${answer.status}`)
        return { _tag: 'Done', status: answer.status } as const
      }).pipe(
        Effect.catchTags({
          NotFound: () =>
            Effect.succeed({
              _tag: 'Refused',
              reason: 'not found: is the match profile live and not declined?',
            } as const),
          RateLimited: () =>
            Effect.succeed({
              _tag: 'Refused',
              reason: 'the match profile hit the weekly pick ceiling',
            } as const),
          Conflict: ({ status }) =>
            Effect.succeed({
              _tag: 'Refused',
              reason: `the setup is already ${status}`,
            } as const),
        }),
        Effect.tap((outcome) =>
          outcome._tag === 'Refused'
            ? Effect.logWarning(`showcase: refused, ${outcome.reason}`)
            : Effect.void
        ),
        Effect.annotateLogs({ showcaseTarget: targetId })
      )

    return {
      stage,

      /**
       * Called by publish. For the showcase phone, schedules the date request
       * after the delay and returns at once. `AfterResponse` keeps the
       * Vercel Function alive until it has gone out; the default delay sits
       * well inside the function's maximum duration.
       */
      published: (profileId: ProfileId, phone: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const target = yield* showcasePhone
          if (Option.isNone(target) || digits(target.value) !== digits(phone))
            return
          if (Option.isNone(yield* showcaseMatchId)) {
            return yield* Effect.logWarning(
              'showcase: SHOWCASE_PHONE published, but SHOWCASE_MATCH_PROFILE_ID is not set'
            )
          }
          const seconds = yield* delay
          yield* Effect.logInfo(
            `showcase: date request scheduled in ${seconds}s`
          ).pipe(Effect.annotateLogs({ showcaseTarget: profileId }))
          yield* afterResponse.run(
            Effect.sleep(Duration.seconds(seconds)).pipe(
              Effect.zipRight(stage(profileId)),
              Effect.asVoid
            )
          )
        }),
    }
  }),
}) {}
