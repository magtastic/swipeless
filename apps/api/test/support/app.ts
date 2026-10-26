import { PgDrizzle } from '@swipeless/db'
import {
  hasTestDb,
  migrate,
  TestDbLive,
  truncateAll,
} from '@swipeless/db/testing'
import {
  makeProfilePhotos,
  memoryBlobStore,
  ProfilePhotos,
  type StoredPhoto,
} from '@swipeless/photos'
import {
  Clock,
  ConfigProvider,
  Duration,
  Effect,
  Layer,
  Logger,
  LogLevel,
  ManagedRuntime,
} from 'effect'
import { AfterResponse, makeAfterResponse } from '../../src/after-response.ts'
import { Caller } from '../../src/caller.ts'
import { DateSuggesterRules } from '../../src/date-suggester.ts'
import { EmbeddingModelDeterministic } from '../../src/embeddings.ts'
import { makeWebHandler } from '../../src/http.ts'
import { Notifier } from '../../src/notifier.ts'
import { Swipeless } from '../../src/service.ts'

/**
 * The whole API as production wires it — the web handler the Vercel Function
 * exports, REST and MCP, the real Caller, service, setup lifecycle and date
 * suggester over a real Postgres — with only what lives outside the process
 * substituted:
 *
 * - OpenAI: embeddings are a hash of the brief, so ranking is reproducible.
 * - Vercel Blob: photos live in a Map. Image validation and link signing run real.
 * - ChatGPT's file downloads: an upload's bytes come from a Map by URL. The
 *   host allowlist, size cap and image check run real.
 * - SMS: the notifier records who would have been told what.
 * - The wall clock: frozen at START until a test travels, so expiry, the weekly
 *   cap and the suggested date are exact.
 *
 * Work a request leaves running after its response, as Vercel's `waitUntil`
 * does, is finished before the handler's promise resolves, so a test sees the
 * world as it is once that work is done.
 */

export { hasTestDb }

/** Tuesday 2026-09-01 09:00 UTC. */
export const START = Date.parse('2026-09-01T09:00:00Z')
export const PHOTO_SECRET = 'test-only-secret'

export type WebHandler = (request: Request) => Promise<Response>

export type Notification = {
  readonly kind: 'dateRequested' | 'dateConfirmed'
  readonly profileId: string
  readonly setupId: string
}

export type App = {
  readonly handler: WebHandler
  /** Moves the server's clock forward. */
  readonly travel: (duration: Duration.DurationInput) => void
  readonly now: () => number
  /** Objects in the fake blob store, by key. */
  readonly photos: ReadonlyMap<string, StoredPhoto>
  /** Files ChatGPT would serve, by download URL. Anything else fails to download. */
  readonly uploads: Map<string, Uint8Array>
  /** Whether the admin's photo route would accept this link at `at`. */
  readonly photoLinkValid: (
    profileId: string,
    link: URLSearchParams,
    at: number
  ) => boolean
  /** Every message the service asked to send, oldest first. */
  readonly notifications: ReadonlyArray<Notification>
  /** Reads straight from the database, for what no endpoint shows. */
  readonly query: <A>(
    f: (db: PgDrizzle.PgDrizzle['Type']) => Effect.Effect<A, unknown>
  ) => Promise<A>
  readonly reset: () => Promise<void>
  readonly dispose: () => Promise<void>
}

export type AppOptions = {
  /** INTEREST_WEEKLY_CAP, so the ceiling can be reached in a few calls. */
  readonly weeklyCap?: number
}

/** A clock that reads the time from `read` and sleeps for real. */
const clockReading = (read: () => number): Clock.Clock => {
  const live = Clock.make()
  return {
    [Clock.ClockTypeId]: Clock.ClockTypeId,
    unsafeCurrentTimeMillis: read,
    currentTimeMillis: Effect.sync(read),
    unsafeCurrentTimeNanos: () => BigInt(read()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(read()) * 1_000_000n),
    sleep: (duration) => live.sleep(duration),
  }
}

export const openApp = (options: AppOptions = {}): App => {
  let at = START
  const clock = clockReading(() => at)

  const photos = new Map<string, StoredPhoto>()
  const uploads = new Map<string, Uint8Array>()
  const profilePhotos = makeProfilePhotos({
    blobs: memoryBlobStore(photos),
    download: (url, limit) => {
      const bytes = uploads.get(url.href)
      return bytes === undefined
        ? Effect.fail(new Error(`404 at ${url.href}`))
        : Effect.succeed(bytes.byteLength > limit ? undefined : bytes)
    },
    secret: PHOTO_SECRET,
    baseUrl: 'https://photos.example',
  })
  const Photos = Layer.succeed(ProfilePhotos, profilePhotos)

  const notifications: Array<Notification> = []
  const record =
    (kind: Notification['kind']) => (profileId: string, setupId: string) =>
      Effect.sync(() => void notifications.push({ kind, profileId, setupId }))
  const RecordingNotifier = Layer.succeed(
    Notifier,
    Notifier.of({
      dateRequested: record('dateRequested'),
      dateConfirmed: record('dateConfirmed'),
    })
  )

  const config =
    options.weeklyCap === undefined
      ? Layer.empty
      : Layer.setConfigProvider(
          ConfigProvider.fromMap(
            new Map([['INTEREST_WEEKLY_CAP', String(options.weeklyCap)]])
          ).pipe(ConfigProvider.orElse(() => ConfigProvider.fromEnv()))
        )

  const pending = new Set<Promise<void>>()
  const AfterResponseTracked = Layer.succeed(
    AfterResponse,
    makeAfterResponse((promise) => {
      pending.add(promise)
      void promise.finally(() => pending.delete(promise))
    })
  )
  const settle = async () => {
    while (pending.size > 0) await Promise.all(pending)
  }

  const AppLayer = Layer.mergeAll(Swipeless.Default, Caller.Default).pipe(
    Layer.provide(EmbeddingModelDeterministic),
    Layer.provide(AfterResponseTracked),
    Layer.provide(DateSuggesterRules),
    Layer.provide(RecordingNotifier),
    Layer.provideMerge(Photos),
    Layer.provideMerge(TestDbLive),
    Layer.provide(config),
    Layer.provide(Layer.setClock(clock)),
    // The request logger would print a line per call.
    Layer.provide(Logger.minimumLogLevel(LogLevel.Warning))
  )

  const runtime = ManagedRuntime.make(AppLayer)
  const web = makeWebHandler(AppLayer)
  let migrated = false

  return {
    handler: async (request) => {
      const response = await web.handler(request)
      await settle()
      return response
    },
    travel: (duration) => {
      at += Duration.toMillis(duration)
    },
    now: () => at,
    photos,
    uploads,
    photoLinkValid: (profileId, link, when) =>
      Effect.runSync(
        profilePhotos
          .verifyLink(profileId, link)
          .pipe(Effect.withClock(clockReading(() => when)))
      ),
    notifications,
    query: (f) =>
      runtime.runPromise(Effect.flatMap(PgDrizzle.PgDrizzle, (db) => f(db))),
    reset: async () => {
      at = START
      photos.clear()
      uploads.clear()
      notifications.length = 0
      if (!migrated) {
        await runtime.runPromise(migrate)
        migrated = true
      }
      await runtime.runPromise(truncateAll)
    },
    dispose: async () => {
      await web.dispose()
      await runtime.dispose()
    },
  }
}

/** Says out loud that a suite did not run, rather than passing silently. */
export const warnSkipped = (file: string): void => {
  if (!hasTestDb) {
    console.warn(
      `\n  ${file} SKIPPED: TEST_DATABASE_URL is not set. ` +
        'Run `bun run test:db` to exercise it.\n'
    )
  }
}
