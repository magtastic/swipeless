import { waitUntil } from '@vercel/functions'
import { Context, Effect, Layer, Runtime } from 'effect'

/**
 * Work that has to happen but that the caller need not wait for. The agent
 * gets its answer first; this keeps running after the response is sent.
 *
 * `run` starts the effect on the current fiber's runtime, so it keeps the
 * request's clock, logger and services, and hands the promise to `keep`.
 * Failures are logged here: nobody is left to tell.
 */
export class AfterResponse extends Context.Tag('AfterResponse')<
  AfterResponse,
  { readonly run: (effect: Effect.Effect<void>) => Effect.Effect<void> }
>() {}

export const makeAfterResponse = (
  keep: (promise: Promise<void>) => void
): AfterResponse['Type'] => ({
  run: (effect) =>
    Effect.flatMap(Effect.runtime<never>(), (runtime) =>
      Effect.sync(() =>
        keep(
          Runtime.runPromise(runtime)(
            effect.pipe(
              Effect.catchAllCause((cause) =>
                Effect.logError('Work after the response failed', cause)
              )
            )
          )
        )
      )
    ),
})

/**
 * Vercel freezes a function once it has answered unless it is told to wait;
 * `waitUntil` tells it. Outside Vercel it does nothing and the promise simply
 * runs on.
 */
export const AfterResponseVercel = Layer.succeed(
  AfterResponse,
  makeAfterResponse(waitUntil)
)

/** For scripts, which have no response to send first: run it in place. */
export const AfterResponseInline = Layer.succeed(AfterResponse, {
  run: (effect) => effect,
})
