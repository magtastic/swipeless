import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { PgDrizzle } from '@swipeless/db'
import { profiles } from '@swipeless/db/schema'
import {
  hasTestDb,
  migrate,
  TestDbLive,
  truncateAll,
} from '@swipeless/db/testing'
import { Gone, PrivateLayer, Profile, Unauthorized } from '@swipeless/shared'
import { eq } from 'drizzle-orm'
import {
  Duration,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  TestClock,
  TestContext,
} from 'effect'
import { Caller, tokenFromAuthorization } from '../src/caller.ts'
import { EmbeddingModelDeterministic } from '../src/embeddings.ts'
import { Swipeless } from '../src/service.ts'
import { TestPhotos } from './support/photos.ts'
import { TestSeams } from './support/seams.ts'

/**
 * The Caller module against a real Postgres. Everything worth testing here is
 * about a row and a clock: the lookup by hash, the check-in that keeps a
 * profile alive, and the ninety-day line PRODUCT.md draws.
 */

if (!hasTestDb) {
  console.warn(
    '\n' +
      '  ###########################################################\n' +
      '  #  caller.test.ts SKIPPED: TEST_DATABASE_URL is not set.  #\n' +
      '  #  Run `bun run test:db` to exercise the database.        #\n' +
      '  ###########################################################\n'
  )
}

const TestLayer = Layer.mergeAll(Caller.Default, Swipeless.Default).pipe(
  Layer.provide(EmbeddingModelDeterministic),
  Layer.provide(TestPhotos),
  Layer.provide(TestSeams),
  Layer.provideMerge(TestDbLive)
)

const runtime = ManagedRuntime.make(TestLayer)

const profileFixture = new Profile({
  age: 34,
  gender: 'woman',
  interestedIn: ['man'],
  city: 'Reykjavík',
  country: 'IS',
  radiusKm: 25,
  availability: 'weekday evenings, sunday afternoons',
  brief:
    'She is a hydrologist who reads the weather like other people read faces. ' +
    'She values directness. Dealbreaker: calling a car park a hike.',
  firstName: 'Sigrún',
  photoUrl: 'https://example.invalid/sigrun.jpg',
  privateLayer: new PrivateLayer({ phone: '+3548221234' }),
})

/** Publishing is the only way a token is ever issued, so tests use it. */
const publish = Swipeless.pipe(
  Effect.flatMap((service) => service.publish(profileFixture))
)

const lastSeenAt = (profileId: string) =>
  PgDrizzle.PgDrizzle.pipe(
    Effect.flatMap((db) =>
      db
        .select({ lastSeenAt: profiles.lastSeenAt })
        .from(profiles)
        .where(eq(profiles.id, profileId))
    ),
    Effect.map((rows) => rows[0]?.lastSeenAt)
  )

/* -------------------------------------------------------------------------- */
/*  The header parser is pure, so it needs no database.                       */
/* -------------------------------------------------------------------------- */

describe('tokenFromAuthorization', () => {
  const parse = (header: string | undefined) =>
    Effect.runSyncExit(tokenFromAuthorization(header))

  test('reads the token out of a Bearer header, whatever the case', () => {
    expect(parse('Bearer abc123')).toEqual(Exit.succeed('abc123'))
    expect(parse('bearer abc123')).toEqual(Exit.succeed('abc123'))
    expect(parse('BEARER   abc123  ')).toEqual(Exit.succeed('abc123'))
  })

  test('anything else is Unauthorized', () => {
    for (const header of [
      undefined,
      '',
      'abc123',
      'Bearer',
      'Bearer ',
      'Basic abc123',
      'Bearer abc 123',
    ]) {
      expect(parse(header)).toEqual(Exit.fail(new Unauthorized()))
    }
  })
})

/* -------------------------------------------------------------------------- */

const describeDb = hasTestDb ? describe : describe.skip

describeDb('Caller', () => {
  beforeAll(() => runtime.runPromise(migrate))
  beforeEach(() => runtime.runPromise(truncateAll))
  afterAll(() => runtime.dispose())

  test('resolves a published token to the profile it was issued for', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const caller = yield* Caller
        const published = yield* publish

        const resolved = yield* caller.resolve(published.token)

        return { published, resolved }
      })
    )

    expect(result.resolved.profileId).toBe(result.published.profileId)
  })

  test('a resolve is a check-in: it bumps last_seen_at', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const caller = yield* Caller
        const published = yield* publish

        const before = yield* lastSeenAt(published.profileId)
        yield* TestClock.adjust(Duration.days(10))
        yield* caller.resolve(published.token)
        const after = yield* lastSeenAt(published.profileId)

        return { before, after }
      }).pipe(Effect.provide(TestContext.TestContext))
    )

    expect(result.before).toBeDefined()
    expect(result.after).toBeDefined()
    expect(result.after?.getTime()).toBe(
      (result.before?.getTime() ?? 0) + Duration.toMillis(Duration.days(10))
    )
  })

  test('a token that was never issued is Unauthorized', async () => {
    const exit = await runtime.runPromiseExit(
      Effect.gen(function* () {
        const caller = yield* Caller
        yield* publish
        return yield* caller.resolve('not-a-token-anyone-was-given')
      })
    )

    expect(exit).toEqual(Exit.fail(new Unauthorized()))
  })

  test('a malformed Authorization header never reaches the database', async () => {
    const exit = await runtime.runPromiseExit(
      Effect.gen(function* () {
        const caller = yield* Caller
        const published = yield* publish
        // The token is real; the header around it is not.
        const token = yield* tokenFromAuthorization(`Token ${published.token}`)
        return yield* caller.resolve(token)
      })
    )

    expect(exit).toEqual(Exit.fail(new Unauthorized()))
  })

  test('ninety days without a check-in is Gone', async () => {
    const exit = await runtime.runPromiseExit(
      Effect.gen(function* () {
        const caller = yield* Caller
        const published = yield* publish

        yield* TestClock.adjust(Duration.days(91))

        return yield* caller.resolve(published.token)
      }).pipe(Effect.provide(TestContext.TestContext))
    )

    expect(exit).toEqual(Exit.fail(new Gone()))
  })

  test('a token that was valid and then expired is Gone, not Unauthorized', async () => {
    const result = await runtime.runPromiseExit(
      Effect.gen(function* () {
        const caller = yield* Caller
        const published = yield* publish

        // Checking in at day 50 buys another ninety days from there...
        yield* TestClock.adjust(Duration.days(50))
        const midway = yield* caller.resolve(published.token)
        expect(midway.profileId).toBe(published.profileId)

        // ...and day 141 is past the line even so.
        yield* TestClock.adjust(Duration.days(91))
        return yield* caller.resolve(published.token)
      }).pipe(Effect.provide(TestContext.TestContext))
    )

    expect(result).toEqual(Exit.fail(new Gone()))
  })
})
