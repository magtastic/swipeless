import { PgDrizzle } from '@swipeless/db'
import {
  hasTestDb,
  migrate,
  TestDbLive,
  truncateAll,
} from '@swipeless/db/testing'
import { recordingMailer } from '@swipeless/email/testing'
import {
  makeProfilePhotos,
  memoryBlobStore,
  ProfilePhotos,
  type StoredPhoto,
} from '@swipeless/photos'
import type { ProfileId, SetupId } from '@swipeless/shared'
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
import { FitWriter, FitWriterNone } from '../../src/fit-writer.ts'
import { makeWebHandler } from '../../src/http.ts'
import { Notifier, NotifierLive } from '../../src/notifier.ts'
import { Swipeless } from '../../src/service.ts'
import { Sms, type Text } from '../../src/sms.ts'

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
 * - Twilio and Resend: texts and emails are kept, not sent. The notifier
 *   that writes them is the real one; it also records who was told what.
 * - Anthropic: no "why you might click" line.
 * - The wall clock: frozen at START until a test travels, so expiry, the weekly
 *   cap and the suggested date are exact. A sleep ends when travel passes it.
 *
 * Work a request leaves running after its response, as Vercel's `waitUntil`
 * does, is finished before the handler's promise resolves, so a test sees the
 * world as it is once that work is done. Work asleep until a later time is
 * the exception: it goes on once the test travels there, and `settle` waits
 * for it.
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
  /** Every text that would have gone through Twilio, oldest first. */
  readonly texts: ReadonlyArray<Text>
  /** Every text from now on fails the way Twilio refuses one. */
  readonly failTexts: () => void
  /** Sets config the app reads per call. Unset again on reset. */
  readonly env: { readonly set: (name: string, value: string) => void }
  /** Waits for the work responses left running, except what is asleep. */
  readonly settle: () => Promise<void>
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

/**
 * The app's clock: the time is `at`, and a sleep wakes when `travel` moves
 * `at` past its end rather than after real time passes.
 */
const travellingClock = () => {
  let at = START
  const sleepers = new Set<{ until: number; wake: () => void }>()
  const clock: Clock.Clock = {
    ...clockReading(() => at),
    sleep: (duration) =>
      Effect.async<void>((resume) => {
        const sleeper = {
          until: at + Duration.toMillis(duration),
          wake: () => resume(Effect.void),
        }
        if (sleeper.until <= at) return sleeper.wake()
        sleepers.add(sleeper)
        return Effect.sync(() => void sleepers.delete(sleeper))
      }),
  }
  const moveTo = (to: number) => {
    at = to
    for (const sleeper of sleepers) {
      if (sleeper.until <= at) {
        sleepers.delete(sleeper)
        sleeper.wake()
      }
    }
  }
  /** Back to START, and any sleep still waiting never wakes. */
  const restart = () => {
    sleepers.clear()
    at = START
  }
  return { clock, now: () => at, moveTo, restart, asleep: () => sleepers.size }
}

export const openApp = (options: AppOptions = {}): App => {
  const time = travellingClock()
  const clock = time.clock

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

  const texts: Array<Text> = []
  let textsFail = false
  const RecordingSms = Layer.succeed(
    Sms,
    Sms.of({
      send: (text) =>
        textsFail
          ? Effect.die(new Error('Twilio answered 400 (21612)'))
          : Effect.sync(() => void texts.push(text)),
    })
  )
  const mailer = recordingMailer()

  // The real notifier, with a note of each call on the way through.
  const notifications: Array<Notification> = []
  const RecordingNotifier = Layer.effect(
    Notifier,
    Effect.map(Notifier, (live) => {
      const record =
        (kind: Notification['kind']) =>
        (profileId: ProfileId, setupId: SetupId) =>
          Effect.sync(
            () => void notifications.push({ kind, profileId, setupId })
          ).pipe(Effect.zipRight(live[kind](profileId, setupId)))
      return Notifier.of({
        dateRequested: record('dateRequested'),
        dateConfirmed: record('dateConfirmed'),
      })
    })
  ).pipe(
    Layer.provide(NotifierLive),
    Layer.provide(FitWriterNone),
    Layer.provide(mailer.layer),
    Layer.provide(RecordingSms)
  )

  const config =
    options.weeklyCap === undefined
      ? Layer.empty
      : Layer.setConfigProvider(
          ConfigProvider.fromMap(
            new Map([['INTEREST_WEEKLY_CAP', String(options.weeklyCap)]])
          ).pipe(ConfigProvider.orElse(() => ConfigProvider.fromEnv()))
        )

  // Config the app reads per call comes from the environment; the names a
  // test sets are unset again on reset.
  const setNames = new Set<string>()
  const env = {
    set: (name: string, value: string) => {
      setNames.add(name)
      process.env[name] = value
    },
  }

  const pending = new Set<Promise<void>>()
  const AfterResponseTracked = Layer.succeed(
    AfterResponse,
    makeAfterResponse((promise) => {
      pending.add(promise)
      void promise.finally(() => pending.delete(promise))
    })
  )
  // Done when nothing runs but the work asleep until the test travels.
  const settle = async () => {
    while (pending.size > time.asleep()) {
      await Promise.race([...pending, new Promise((r) => setTimeout(r, 1))])
    }
  }

  // The model behind the page's "why you might click", answering at once.
  const PageFitWriter = Layer.succeed(
    FitWriter,
    FitWriter.of({
      whyYouFit: ({ otherFirstName }) =>
        Effect.succeed(`you and ${otherFirstName} both swim in the sea.`),
    })
  )

  const AppLayer = Layer.mergeAll(Swipeless.Default, Caller.Default).pipe(
    Layer.provide(PageFitWriter),
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
    travel: (duration) => time.moveTo(time.now() + Duration.toMillis(duration)),
    now: time.now,
    photos,
    uploads,
    photoLinkValid: (profileId, link, when) =>
      Effect.runSync(
        profilePhotos
          .verifyLink(profileId, link)
          .pipe(Effect.withClock(clockReading(() => when)))
      ),
    notifications,
    texts,
    failTexts: () => {
      textsFail = true
    },
    env,
    settle,
    query: (f) =>
      runtime.runPromise(Effect.flatMap(PgDrizzle.PgDrizzle, (db) => f(db))),
    reset: async () => {
      pending.clear()
      time.restart()
      photos.clear()
      uploads.clear()
      notifications.length = 0
      texts.length = 0
      textsFail = false
      mailer.sent.length = 0
      for (const name of setNames) delete process.env[name]
      setNames.clear()
      if (!migrated) {
        await runtime.runPromise(migrate)
        migrated = true
      }
      await runtime.runPromise(truncateAll)
    },
    dispose: async () => {
      for (const name of setNames) delete process.env[name]
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
