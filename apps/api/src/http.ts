import {
  Etag,
  FileSystem,
  HttpLayerRouter,
  HttpPlatform,
  Path,
} from '@effect/platform'
import type { ProfilePhotos } from '@swipeless/photos'
import { Layer } from 'effect'
import { AnswerRoutes } from './answer-page.ts'
import { SwipelessApi } from './api.ts'
import type { Caller } from './caller.ts'
import { BearerAuthLive, SwipelessGroupLive } from './handlers.ts'
import { addToolMeta, McpRoutes } from './mcp.ts'
import type { Swipeless } from './service.ts'

/**
 * Platform services required by addHttpApi. Deliberately runtime-agnostic —
 * a noop filesystem rather than Bun's or Node's — so the exact same handler
 * runs under `bun run --hot` locally and in a Vercel Function.
 * Nothing here is served from disk.
 */
const PlatformLive = Layer.mergeAll(
  Etag.layer,
  Path.layer,
  HttpPlatform.layer
).pipe(Layer.provideMerge(FileSystem.layerNoop({})))

/** REST routes for the website. */
const ApiRoutes = HttpLayerRouter.addHttpApi(SwipelessApi).pipe(
  Layer.provide(SwipelessGroupLive)
)

/**
 * MCP and REST share one router, so a single web handler serves /mcp
 * alongside every REST route. Both authenticate through the same Caller: the
 * REST middleware is derived from it here rather than passed in, so there is
 * exactly one bearer-auth implementation and no way to wire a second. The
 * small answer page authenticates by its signed link instead.
 */
export const AllRoutes = Layer.mergeAll(
  ApiRoutes,
  McpRoutes,
  AnswerRoutes
).pipe(Layer.provide(BearerAuthLive))

/**
 * Builds the web handler over a given app layer. Production passes AppLive
 * (service + caller over Postgres and OpenAI); the tests pass the same services
 * over the test database, with embeddings, photos and SMS kept in process.
 *
 * The handler adds each tool's `_meta` to tools/list on the way out (see
 * `addToolMeta`). `bun run dev` serves the routes without this wrapper, so
 * locally tools/list carries no `_meta`.
 */
export const makeWebHandler = <E>(
  appLayer: Layer.Layer<Swipeless | Caller | ProfilePhotos, E>
) => {
  const web = HttpLayerRouter.toWebHandler(
    AllRoutes.pipe(Layer.provide(appLayer), Layer.provideMerge(PlatformLive))
  )
  return { ...web, handler: addToolMeta(web.handler) }
}
