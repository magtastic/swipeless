import { HttpApiBuilder } from '@effect/platform'
import { HealthResponse } from '@swipeless/shared'
import { Effect, Layer } from 'effect'
import { BearerAuth, SwipelessApi } from './api.ts'
import { Caller } from './caller.ts'
import { Swipeless } from './service.ts'

/**
 * The REST half of authentication: the platform pulls the token out of the
 * Authorization header, the Caller module does everything else. All this
 * adapter contributes is the wiring, which is the point — the MCP adapter
 * reaches the same `resolve` by a different route.
 */
export const BearerAuthLive = Layer.effect(
  BearerAuth,
  Effect.gen(function* () {
    const caller = yield* Caller
    return BearerAuth.of({ bearer: (token) => caller.resolve(token) })
  })
)

export const SwipelessGroupLive = HttpApiBuilder.group(
  SwipelessApi,
  'swipeless',
  (handlers) =>
    Effect.gen(function* () {
      const service = yield* Swipeless

      return (
        handlers
          .handle('health', () =>
            Effect.succeed(new HealthResponse({ ok: true }))
          )
          .handle('publish', ({ payload }) => service.publish(payload))
          // BearerAuth provides CurrentProfile to every endpoint from here on.
          .handle('candidates', ({ urlParams }) =>
            service.candidates(urlParams.limit)
          )
          .handle('interest', ({ payload }) => service.interest(payload))
          .handle('confirm', ({ payload }) => service.confirm(payload))
          .handle('decline', ({ payload }) => service.decline(payload))
          .handle('deleteProfile', () => service.deleteProfile())
          .handle('setups', () => service.setups())
      )
    })
)
