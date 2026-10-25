import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { PgDrizzle } from '@swipeless/db'
import { profiles, setups } from '@swipeless/db/schema'
import {
  hasTestDb,
  migrate,
  TestDbLive,
  truncateAll,
} from '@swipeless/db/testing'
import {
  PrivateLayer,
  Profile,
  type ProfileId,
  type SetupId,
} from '@swipeless/shared'
import { eq } from 'drizzle-orm'
import {
  Clock,
  ConfigProvider,
  Duration,
  Effect,
  Layer,
  ManagedRuntime,
  TestClock,
  TestContext,
} from 'effect'
import { EmbeddingModelDeterministic } from '../src/embeddings.ts'
import { Swipeless } from '../src/service.ts'
import { SETUP_TTL_MS, SetupLifecycle } from '../src/setups.ts'
import { TestPhotos } from './support/photos.ts'
import { approve } from './support/review.ts'
import { FAKE_DATE, notifications, TestSeams } from './support/seams.ts'

/**
 * The setup lifecycle against a real Postgres, through the five methods the
 * service calls and nothing else. The row, the guard and the ordered pair are
 * exactly the parts a mock would hide, so nothing here is faked but the
 * embedding model, the date suggester (a constant) and the notifier (a
 * recorder), and time, which TestClock owns.
 */

if (!hasTestDb) {
  console.warn(
    '\n' +
      '  ############################################################\n' +
      '  #  setups.test.ts SKIPPED: TEST_DATABASE_URL is not set.   #\n' +
      '  #  Run `bun run test:db` to exercise the database.         #\n' +
      '  ############################################################\n'
  )
}

const TestLayer = Layer.mergeAll(
  SetupLifecycle.Default,
  Swipeless.Default
).pipe(
  Layer.provide(EmbeddingModelDeterministic),
  Layer.provide(TestPhotos),
  Layer.provide(TestSeams),
  Layer.provideMerge(TestDbLive)
)

/**
 * The same layer with a ceiling of two, so the weekly limit can be reached in
 * a test without twenty picks. The map falls back to the environment, which
 * is where TEST_DATABASE_URL still comes from.
 */
const CappedLayer = TestLayer.pipe(
  Layer.provide(
    Layer.setConfigProvider(
      ConfigProvider.fromMap(new Map([['INTEREST_WEEKLY_CAP', '2']])).pipe(
        ConfigProvider.orElse(() => ConfigProvider.fromEnv())
      )
    )
  )
)

const runtime = ManagedRuntime.make(TestLayer)
const cappedRuntime = ManagedRuntime.make(CappedLayer)

type Requirements = SetupLifecycle | Swipeless | PgDrizzle.PgDrizzle

/**
 * Every test runs on TestClock, so a setup created in one test and a setup
 * created in the next both start at the same instant and nothing depends on
 * how long the suite took to run.
 */
const run = <A, E>(effect: Effect.Effect<A, E, Requirements>): Promise<A> =>
  runtime.runPromise(Effect.provide(effect, TestContext.TestContext))

const runCapped = <A, E>(
  effect: Effect.Effect<A, E, Requirements>
): Promise<A> =>
  cappedRuntime.runPromise(Effect.provide(effect, TestContext.TestContext))

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const BRIEF =
  'She is a hydrologist who reads the weather like other people read faces. ' +
  'She values directness. Dealbreaker: calling a car park a hike.'

const UNKNOWN_PROFILE_ID = '00000000-0000-4000-8000-000000000000'

const PHONES: Readonly<Record<string, string>> = {
  Sigrún: '+3548221234',
  Jón: '+3546901234',
  Ari: '+3546905678',
  Einar: '+3546909999',
}

const profileFixture = (firstName: string): Profile =>
  new Profile({
    age: 34,
    gender: 'woman',
    interestedIn: ['man'],
    city: 'Reykjavík',
    country: 'IS',
    radiusKm: 25,
    availability: 'weekday evenings, sunday afternoons',
    brief: `${BRIEF} Called ${firstName}.`,
    firstName,
    photoUrl: `https://example.invalid/${firstName}.jpg`,
    privateLayer: new PrivateLayer({
      phone: PHONES[firstName] ?? '+3540000000',
    }),
  })

/** Publishes and approves: nobody pending can pick or be picked. */
const publishFixture = (firstName: string, { approved = true } = {}) =>
  Swipeless.pipe(
    Effect.flatMap((service) => service.publish(profileFixture(firstName))),
    Effect.map((response) => response.profileId),
    Effect.tap((profileId) => (approved ? approve(profileId) : Effect.void))
  )

const caller = (profileId: ProfileId) => ({ profileId })

/** Sigrún's agent picks Jón. */
const picked = Effect.gen(function* () {
  const lifecycle = yield* SetupLifecycle
  const sigrun = yield* publishFixture('Sigrún')
  const jon = yield* publishFixture('Jón')
  const response = yield* lifecycle.expressInterest(caller(sigrun), jon)
  return { sigrun, jon, setupId: response.setup.setupId, response }
})

/** Sigrún's agent picks Jón and Sigrún says yes. */
const requested = Effect.gen(function* () {
  const lifecycle = yield* SetupLifecycle
  const pair = yield* picked
  yield* lifecycle.confirm(caller(pair.sigrun), pair.setupId)
  return pair
})

/** The row as stored, for the assertions that are about the row itself. */
const rowOf = (setupId: SetupId) =>
  PgDrizzle.PgDrizzle.pipe(
    Effect.flatMap((db) =>
      db.select().from(setups).where(eq(setups.id, setupId))
    ),
    Effect.map((rows) => rows[0])
  )

/** Moves a setup's suggested time to `after` from now on the TestClock. */
const setDateTime = (setupId: SetupId, after: Duration.Duration) =>
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle
    const now = yield* Clock.currentTimeMillis
    const time = new Date(now + Duration.toMillis(after)).toISOString()
    yield* db
      .update(setups)
      .set({ date: { venue: { ...FAKE_DATE.venue }, time } })
      .where(eq(setups.id, setupId))
  })

const describeDb = hasTestDb ? describe : describe.skip

describeDb('SetupLifecycle', () => {
  beforeAll(() => runtime.runPromise(migrate))
  beforeEach(async () => {
    notifications.length = 0
    await runtime.runPromise(truncateAll)
  })
  afterAll(async () => {
    await runtime.dispose()
    await cappedRuntime.dispose()
  })

  /* ------------------------------------------------------------------ */
  /*  The pick                                                          */
  /* ------------------------------------------------------------------ */

  describe('expressInterest', () => {
    test('creates a suggested setup only the picking side can see', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const pair = yield* picked

          const mine = yield* lifecycle.listFor(caller(pair.sigrun))
          const theirs = yield* lifecycle.listFor(caller(pair.jon))

          // Invisible means invisible: the other side cannot act on a setup
          // it is not supposed to know exists.
          const confirmed = yield* Effect.flip(
            lifecycle.confirm(caller(pair.jon), pair.setupId)
          )
          const declined = yield* Effect.flip(
            lifecycle.decline(caller(pair.jon), pair.setupId)
          )

          return { ...pair, mine, theirs, confirmed, declined }
        })
      )

      const setup = result.response.setup
      expect(setup.status).toBe('suggested')
      expect(setup.youPicked).toBe(true)
      expect(setup.youConfirmed).toBe(false)
      expect(setup.date).toEqual(FAKE_DATE)
      expect(setup.counterpart).toEqual({
        profileId: result.jon,
        firstName: 'Jón',
        age: 34,
        photoUrl: 'https://example.invalid/Jón.jpg',
        brief: `${BRIEF} Called Jón.`,
      })
      // No phone number before both say yes.
      expect(setup.counterpartPrivateLayer).toBeUndefined()
      expect(result.mine.setups.map((one) => one.setupId)).toEqual([
        setup.setupId,
      ])
      expect(result.theirs.setups).toHaveLength(0)
      expect(result.confirmed._tag).toBe('NotFound')
      expect(result.declined._tag).toBe('NotFound')
      expect(notifications).toEqual([])
    })

    test('repeating a pick returns the same setup', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const db = yield* PgDrizzle.PgDrizzle
          const pair = yield* picked

          yield* TestClock.adjust(Duration.hours(1))
          const again = yield* lifecycle.expressInterest(
            caller(pair.sigrun),
            pair.jon
          )

          const rows = yield* db.select({ id: setups.id }).from(setups)
          return { ...pair, again, rows }
        })
      )

      expect(result.again.setup.setupId).toBe(result.setupId)
      expect(result.again.setup.status).toBe('suggested')
      expect(result.rows).toHaveLength(1)
    })

    test('picking someone whose agent already picked you joins their setup', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const pair = yield* picked

          const joined = yield* lifecycle.expressInterest(
            caller(pair.jon),
            pair.sigrun
          )
          const sigrunSees = yield* lifecycle.listFor(caller(pair.sigrun))
          const jonSees = yield* lifecycle.listFor(caller(pair.jon))

          return { ...pair, joined, sigrunSees, jonSees }
        })
      )

      // One pair, one row, whoever picked first.
      expect(result.joined.setup.setupId).toBe(result.setupId)
      // Both still owe a yes.
      expect(result.joined.setup.status).toBe('suggested')
      expect(result.joined.setup.youPicked).toBe(true)
      expect(result.joined.setup.counterpart.firstName).toBe('Sigrún')
      expect(result.sigrunSees.setups).toHaveLength(1)
      expect(result.jonSees.setups).toHaveLength(1)
    })

    test('a target that is missing, unapproved, expired, or the caller is NotFound', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const db = yield* PgDrizzle.PgDrizzle
          const sigrun = yield* publishFixture('Sigrún')
          const pending = yield* publishFixture('Ari', { approved: false })
          const rejected = yield* publishFixture('Einar')
          yield* db
            .update(profiles)
            .set({ reviewStatus: 'rejected' })
            .where(eq(profiles.id, rejected))
          const stale = yield* publishFixture('Jón')

          const self = yield* Effect.flip(
            lifecycle.expressInterest(caller(sigrun), sigrun)
          )
          const unknown = yield* Effect.flip(
            lifecycle.expressInterest(caller(sigrun), UNKNOWN_PROFILE_ID)
          )
          const unapproved = yield* Effect.flip(
            lifecycle.expressInterest(caller(sigrun), pending)
          )
          const refused = yield* Effect.flip(
            lifecycle.expressInterest(caller(sigrun), rejected)
          )

          // Ninety days without a check-in and the profile is out of the pool.
          yield* TestClock.adjust(Duration.days(91))
          const expired = yield* Effect.flip(
            lifecycle.expressInterest(caller(sigrun), stale)
          )

          return { self, unknown, unapproved, refused, expired }
        })
      )

      expect(result.self._tag).toBe('NotFound')
      expect(result.unknown._tag).toBe('NotFound')
      expect(result.unapproved._tag).toBe('NotFound')
      expect(result.refused._tag).toBe('NotFound')
      expect(result.expired._tag).toBe('NotFound')
    })

    test('a caller still waiting on review cannot pick', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const sigrun = yield* publishFixture('Sigrún', { approved: false })
          const jon = yield* publishFixture('Jón')
          return yield* Effect.flip(
            lifecycle.expressInterest(caller(sigrun), jon)
          )
        })
      )

      expect(result._tag).toBe('NotFound')
    })

    test('a declined pair is closed for good, for both sides', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const pair = yield* picked
          yield* lifecycle.decline(caller(pair.sigrun), pair.setupId)

          const again = yield* Effect.flip(
            lifecycle.expressInterest(caller(pair.sigrun), pair.jon)
          )
          const reverse = yield* Effect.flip(
            lifecycle.expressInterest(caller(pair.jon), pair.sigrun)
          )
          return { again, reverse }
        })
      )

      expect(result.again._tag).toBe('NotFound')
      expect(result.reverse._tag).toBe('NotFound')
    })

    test('an expired pair is not closed: a fresh pick starts a new setup', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const db = yield* PgDrizzle.PgDrizzle
          // Both picked, so both could see the old setup.
          const pair = yield* picked
          yield* lifecycle.expressInterest(caller(pair.jon), pair.sigrun)
          yield* TestClock.adjust(Duration.days(15))

          const fresh = yield* lifecycle.expressInterest(
            caller(pair.sigrun),
            pair.jon
          )
          const rows = yield* db.select().from(setups)
          const jonSees = yield* lifecycle.listFor(caller(pair.jon))
          const old = yield* Effect.flip(
            lifecycle.confirm(caller(pair.sigrun), pair.setupId)
          )
          return { ...pair, fresh, rows, jonSees, old }
        })
      )

      expect(result.fresh.setup.setupId).not.toBe(result.setupId)
      expect(result.fresh.setup.status).toBe('suggested')
      expect(result.fresh.setup.youPicked).toBe(true)
      expect(result.fresh.setup.expiresAt).toBe(
        new Date(15 * 24 * 60 * 60 * 1000 + SETUP_TTL_MS).toISOString()
      )
      // One row per pair: the expired one is gone, and with it the other
      // side's old pick, so the new setup is the picker's alone.
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0]?.interestedAAt === null).not.toBe(
        result.rows[0]?.interestedBAt === null
      )
      expect(result.jonSees.setups).toHaveLength(0)
      expect(result.old._tag).toBe('NotFound')
    })

    test('a pair whose suggested time passed can be picked again', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const pair = yield* picked
          yield* setDateTime(pair.setupId, Duration.days(3))
          yield* TestClock.adjust(Duration.days(4))
          return yield* lifecycle.expressInterest(caller(pair.sigrun), pair.jon)
        })
      )

      expect(result.setup.status).toBe('suggested')
    })

    test('joining a setup restarts its fourteen days', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const pair = yield* picked
          yield* TestClock.adjust(Duration.days(10))
          const joined = yield* lifecycle.expressInterest(
            caller(pair.jon),
            pair.sigrun
          )
          // Past the original fourteen days, inside the restarted ones.
          yield* TestClock.adjust(Duration.days(10))
          const later = yield* lifecycle.listFor(caller(pair.sigrun))
          return { joined, later }
        })
      )

      expect(result.joined.setup.expiresAt).toBe(
        new Date(10 * 24 * 60 * 60 * 1000 + SETUP_TTL_MS).toISOString()
      )
      expect(result.later.setups[0]?.status).toBe('suggested')
    })
  })

  describe('the weekly ceiling', () => {
    test('stops the third pick in a week and says how long to wait', async () => {
      const result = await runCapped(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const sigrun = yield* publishFixture('Sigrún')
          const jon = yield* publishFixture('Jón')
          const ari = yield* publishFixture('Ari')
          const einar = yield* publishFixture('Einar')

          yield* lifecycle.expressInterest(caller(sigrun), jon)
          // Repeating one does not spend another.
          yield* lifecycle.expressInterest(caller(sigrun), jon)
          yield* TestClock.adjust(Duration.hours(1))
          yield* lifecycle.expressInterest(caller(sigrun), ari)

          const limited = yield* Effect.flip(
            lifecycle.expressInterest(caller(sigrun), einar)
          )

          // A week after the first pick, one slot frees up.
          yield* TestClock.adjust(Duration.days(7))
          const later = yield* lifecycle.expressInterest(caller(sigrun), einar)

          return { limited, later }
        })
      )

      expect(result.limited._tag).toBe('RateLimited')
      if (result.limited._tag === 'RateLimited') {
        expect(result.limited.retryAfterSeconds).toBe(7 * 24 * 60 * 60 - 3600)
      }
      expect(result.later.setup.status).toBe('suggested')
    })

    test('joining a setup the other side started spends a pick', async () => {
      const result = await runCapped(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const sigrun = yield* publishFixture('Sigrún')
          const jon = yield* publishFixture('Jón')
          const ari = yield* publishFixture('Ari')
          const einar = yield* publishFixture('Einar')

          yield* lifecycle.expressInterest(caller(jon), sigrun)
          yield* lifecycle.expressInterest(caller(sigrun), ari)
          yield* lifecycle.expressInterest(caller(sigrun), jon)

          return yield* Effect.flip(
            lifecycle.expressInterest(caller(sigrun), einar)
          )
        })
      )

      expect(result._tag).toBe('RateLimited')
    })
  })

  /* ------------------------------------------------------------------ */
  /*  The yes                                                           */
  /* ------------------------------------------------------------------ */

  describe('confirm', () => {
    test('the first yes sends the date request to the other side', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const pair = yield* picked

          yield* TestClock.adjust(Duration.hours(2))
          const yes = yield* lifecycle.confirm(
            caller(pair.sigrun),
            pair.setupId
          )
          const jonSees = yield* lifecycle.listFor(caller(pair.jon))
          const sigrunSees = yield* lifecycle.listFor(caller(pair.sigrun))
          const row = yield* rowOf(pair.setupId)

          return { ...pair, yes, jonSees, sigrunSees, row }
        })
      )

      expect(result.yes.status).toBe('requested')
      expect(result.yes.privateLayer).toBeUndefined()
      expect(notifications).toEqual([
        {
          kind: 'dateRequested',
          profileId: result.jon,
          setupId: result.setupId,
        },
      ])

      const jonView = result.jonSees.setups[0]
      expect(jonView?.status).toBe('requested')
      expect(jonView?.youPicked).toBe(false)
      expect(jonView?.youConfirmed).toBe(false)
      expect(jonView?.counterpart.firstName).toBe('Sigrún')
      // Jón's agent never saw Sigrún as a candidate; the brief lets it write the note.
      expect(jonView?.counterpart.brief).toBe(`${BRIEF} Called Sigrún.`)
      expect(jonView?.date).toEqual(FAKE_DATE)
      expect(jonView?.counterpartPrivateLayer).toBeUndefined()
      expect(result.sigrunSees.setups[0]?.youConfirmed).toBe(true)

      // A transition refreshes the fourteen days.
      expect(result.row?.expiresAt.getTime()).toBe(
        2 * 60 * 60 * 1000 + SETUP_TTL_MS
      )
    })

    test('the second yes confirms and releases both phone numbers', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const pair = yield* requested

          const yes = yield* lifecycle.confirm(caller(pair.jon), pair.setupId)
          const sigrunSees = yield* lifecycle.listFor(caller(pair.sigrun))
          const jonSees = yield* lifecycle.listFor(caller(pair.jon))

          return { ...pair, yes, sigrunSees, jonSees }
        })
      )

      expect(result.yes.status).toBe('confirmed')
      expect(result.yes.privateLayer?.phone).toBe(PHONES.Sigrún)
      expect(result.sigrunSees.setups[0]?.counterpartPrivateLayer?.phone).toBe(
        PHONES.Jón
      )
      expect(result.jonSees.setups[0]?.counterpartPrivateLayer?.phone).toBe(
        PHONES.Sigrún
      )
      expect(
        notifications.filter((one) => one.kind === 'dateConfirmed')
      ).toEqual([
        {
          kind: 'dateConfirmed',
          profileId: result.jon,
          setupId: result.setupId,
        },
        {
          kind: 'dateConfirmed',
          profileId: result.sigrun,
          setupId: result.setupId,
        },
      ])
    })

    test('saying yes twice is the same yes', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const pair = yield* requested

          const again = yield* lifecycle.confirm(
            caller(pair.sigrun),
            pair.setupId
          )
          yield* lifecycle.confirm(caller(pair.jon), pair.setupId)
          const afterConfirmed = yield* lifecycle.confirm(
            caller(pair.jon),
            pair.setupId
          )
          return { again, afterConfirmed }
        })
      )

      expect(result.again.status).toBe('requested')
      expect(result.afterConfirmed.status).toBe('confirmed')
      expect(result.afterConfirmed.privateLayer?.phone).toBe(PHONES.Sigrún)
      // One request, two confirmations: the repeats sent nothing.
      expect(notifications.map((one) => one.kind)).toEqual([
        'dateRequested',
        'dateConfirmed',
        'dateConfirmed',
      ])
    })

    test('when both agents picked, either human may say yes first', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const pair = yield* picked
          yield* lifecycle.expressInterest(caller(pair.jon), pair.sigrun)

          const jonYes = yield* lifecycle.confirm(
            caller(pair.jon),
            pair.setupId
          )
          const sigrunYes = yield* lifecycle.confirm(
            caller(pair.sigrun),
            pair.setupId
          )
          return { jonYes, sigrunYes }
        })
      )

      expect(result.jonYes.status).toBe('requested')
      expect(result.sigrunYes.status).toBe('confirmed')
    })

    test('a yes after a no, or after expiry, is a Conflict with that status', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const declinedPair = yield* requested
          yield* lifecycle.decline(
            caller(declinedPair.jon),
            declinedPair.setupId
          )
          const afterNo = yield* Effect.flip(
            lifecycle.confirm(caller(declinedPair.jon), declinedPair.setupId)
          )

          const ari = yield* publishFixture('Ari')
          const stale = yield* lifecycle.expressInterest(
            caller(declinedPair.sigrun),
            ari
          )
          yield* TestClock.adjust(Duration.days(15))
          const afterExpiry = yield* Effect.flip(
            lifecycle.confirm(caller(declinedPair.sigrun), stale.setup.setupId)
          )

          return { afterNo, afterExpiry }
        })
      )

      expect(result.afterNo).toMatchObject({
        _tag: 'Conflict',
        status: 'declined',
      })
      expect(result.afterExpiry).toMatchObject({
        _tag: 'Conflict',
        status: 'expired',
      })
    })
  })

  /* ------------------------------------------------------------------ */
  /*  Crossing yeses                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Two yeses can reach the guarded write at once. Each case runs a number
   * of times, from an empty table, so an unlucky interleaving has a chance
   * to show up: the stored flags, the status, who got a phone number and who
   * heard what must come out the same however the two calls cross.
   * PRODUCT.md: "When both say yes, both get the other's phone number."
   */
  describe('confirm, concurrently', () => {
    const ROUNDS = 10

    const kinds = (kind: 'dateRequested' | 'dateConfirmed') =>
      notifications.filter((one) => one.kind === kind)

    /** The stored yes of one profile, whichever side of the pair it is. */
    const flagOf = (
      row: { profileAId: string; confirmedA: boolean; confirmedB: boolean },
      profileId: ProfileId
    ) => (row.profileAId === profileId ? row.confirmedA : row.confirmedB)

    test('both sides saying yes at once confirm the date exactly once', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        notifications.length = 0
        await runtime.runPromise(truncateAll)
        const result = await run(
          Effect.gen(function* () {
            const lifecycle = yield* SetupLifecycle
            const pair = yield* picked
            // Both agents picked, so the suggested setup is visible to both.
            yield* lifecycle.expressInterest(caller(pair.jon), pair.sigrun)

            const [sigrunYes, jonYes] = yield* Effect.all(
              [
                lifecycle.confirm(caller(pair.sigrun), pair.setupId),
                lifecycle.confirm(caller(pair.jon), pair.setupId),
              ],
              { concurrency: 'unbounded' }
            )
            const row = yield* rowOf(pair.setupId)
            return { ...pair, sigrunYes, jonYes, row }
          })
        )

        expect(result.row?.status).toBe('confirmed')
        expect(result.row?.confirmedA).toBe(true)
        expect(result.row?.confirmedB).toBe(true)

        // One yes landed first and became the request; the other confirmed
        // and carries the phone number. Never both, never neither.
        const answers = [result.sigrunYes, result.jonYes]
        expect(answers.map((one) => one.status).sort()).toEqual([
          'confirmed',
          'requested',
        ])
        for (const [one, phone] of [
          [result.sigrunYes, PHONES.Jón],
          [result.jonYes, PHONES.Sigrún],
        ] as const) {
          expect(one.privateLayer?.phone).toBe(
            one.status === 'confirmed' ? phone : undefined
          )
        }

        expect(kinds('dateRequested').length).toBeLessThanOrEqual(1)
        expect(
          kinds('dateConfirmed')
            .map((one) => one.profileId)
            .sort()
        ).toEqual([result.sigrun, result.jon].sort())
      }
    })

    test('one side saying yes twice at once is one yes', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        notifications.length = 0
        await runtime.runPromise(truncateAll)
        const result = await run(
          Effect.gen(function* () {
            const lifecycle = yield* SetupLifecycle
            const pair = yield* picked

            const yeses = yield* Effect.all(
              [
                lifecycle.confirm(caller(pair.sigrun), pair.setupId),
                lifecycle.confirm(caller(pair.sigrun), pair.setupId),
              ],
              { concurrency: 'unbounded' }
            )
            const row = yield* rowOf(pair.setupId)
            return { ...pair, yeses, row }
          })
        )

        expect(result.row?.status).toBe('requested')
        if (result.row === undefined) throw new Error('setup row is missing')
        expect(flagOf(result.row, result.sigrun)).toBe(true)
        expect(flagOf(result.row, result.jon)).toBe(false)
        for (const yes of result.yeses) {
          expect(yes.status).toBe('requested')
          expect(yes.privateLayer).toBeUndefined()
        }
        expect(notifications).toEqual([
          {
            kind: 'dateRequested',
            profileId: result.jon,
            setupId: result.setupId,
          },
        ])
      }
    })

    test('the second side saying yes twice at once confirms once', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        notifications.length = 0
        await runtime.runPromise(truncateAll)
        const result = await run(
          Effect.gen(function* () {
            const lifecycle = yield* SetupLifecycle
            const pair = yield* requested

            const yeses = yield* Effect.all(
              [
                lifecycle.confirm(caller(pair.jon), pair.setupId),
                lifecycle.confirm(caller(pair.jon), pair.setupId),
              ],
              { concurrency: 'unbounded' }
            )
            const row = yield* rowOf(pair.setupId)
            return { ...pair, yeses, row }
          })
        )

        expect(result.row?.status).toBe('confirmed')
        expect(result.row?.confirmedA).toBe(true)
        expect(result.row?.confirmedB).toBe(true)
        // Saying yes twice is the same yes: both answers release the number.
        for (const yes of result.yeses) {
          expect(yes.status).toBe('confirmed')
          expect(yes.privateLayer?.phone).toBe(PHONES.Sigrún)
        }
        expect(kinds('dateRequested')).toHaveLength(1)
        expect(
          kinds('dateConfirmed')
            .map((one) => one.profileId)
            .sort()
        ).toEqual([result.sigrun, result.jon].sort())
      }
    })
  })

  /* ------------------------------------------------------------------ */
  /*  The no                                                            */
  /* ------------------------------------------------------------------ */

  describe('decline', () => {
    test('a no on a suggested setup never reaches the other side', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const pair = yield* picked

          const no = yield* lifecycle.decline(caller(pair.sigrun), pair.setupId)
          const sigrunSees = yield* lifecycle.listFor(caller(pair.sigrun))
          const jonSees = yield* lifecycle.listFor(caller(pair.jon))

          return { no, sigrunSees, jonSees }
        })
      )

      expect(result.no.status).toBe('declined')
      expect(result.sigrunSees.setups[0]?.status).toBe('declined')
      expect(result.jonSees.setups).toHaveLength(0)
    })

    test('the requested side may say no, and both see it is not happening', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const pair = yield* requested

          const no = yield* lifecycle.decline(caller(pair.jon), pair.setupId)
          const sigrunSees = yield* lifecycle.listFor(caller(pair.sigrun))
          const jonSees = yield* lifecycle.listFor(caller(pair.jon))

          return { no, sigrunSees, jonSees }
        })
      )

      expect(result.no.status).toBe('declined')
      expect(result.sigrunSees.setups[0]?.status).toBe('declined')
      expect(
        result.sigrunSees.setups[0]?.counterpartPrivateLayer
      ).toBeUndefined()
      expect(result.jonSees.setups[0]?.status).toBe('declined')
    })

    test('nothing to say no to once both said yes', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const pair = yield* requested
          yield* lifecycle.confirm(caller(pair.jon), pair.setupId)

          const late = yield* Effect.flip(
            lifecycle.decline(caller(pair.sigrun), pair.setupId)
          )
          const twice = yield* Effect.flip(
            lifecycle.decline(caller(pair.jon), pair.setupId)
          )
          return { late, twice }
        })
      )

      expect(result.late).toMatchObject({
        _tag: 'Conflict',
        status: 'confirmed',
      })
      expect(result.twice).toMatchObject({
        _tag: 'Conflict',
        status: 'confirmed',
      })
    })
  })

  /* ------------------------------------------------------------------ */
  /*  Time                                                              */
  /* ------------------------------------------------------------------ */

  describe('expiry', () => {
    test('a date whose time has passed reads as expired; yes and no answer Conflict', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const pair = yield* requested
          yield* setDateTime(pair.setupId, Duration.days(3))

          const before = yield* lifecycle.listFor(caller(pair.jon))
          yield* TestClock.adjust(Duration.days(3))
          const after = yield* lifecycle.listFor(caller(pair.jon))
          const yes = yield* Effect.flip(
            lifecycle.confirm(caller(pair.jon), pair.setupId)
          )
          const no = yield* Effect.flip(
            lifecycle.decline(caller(pair.jon), pair.setupId)
          )
          return { before, after, yes, no }
        })
      )

      expect(result.before.setups[0]?.status).toBe('requested')
      expect(result.after.setups[0]?.status).toBe('expired')
      expect(result.yes).toMatchObject({ _tag: 'Conflict', status: 'expired' })
      expect(result.no).toMatchObject({ _tag: 'Conflict', status: 'expired' })
    })

    test('a confirmed date stays confirmed after its time', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const pair = yield* requested
          yield* setDateTime(pair.setupId, Duration.days(3))
          yield* lifecycle.confirm(caller(pair.jon), pair.setupId)
          yield* TestClock.adjust(Duration.days(30))
          return yield* lifecycle.listFor(caller(pair.sigrun))
        })
      )

      expect(result.setups[0]?.status).toBe('confirmed')
      expect(result.setups[0]?.counterpartPrivateLayer?.phone).toBe(PHONES.Jón)
    })

    test('fourteen days without a transition reads as expired; a confirmed date never does', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const pair = yield* picked
          const ari = yield* publishFixture('Ari')
          const date = yield* lifecycle.expressInterest(
            caller(pair.sigrun),
            ari
          )
          yield* lifecycle.confirm(caller(pair.sigrun), date.setup.setupId)
          yield* lifecycle.confirm(caller(ari), date.setup.setupId)

          yield* TestClock.adjust(Duration.days(13))
          const before = yield* lifecycle.listFor(caller(pair.sigrun))
          yield* TestClock.adjust(Duration.days(2))
          const after = yield* lifecycle.listFor(caller(pair.sigrun))
          const row = yield* rowOf(pair.setupId)

          return {
            ...pair,
            confirmedId: date.setup.setupId,
            before,
            after,
            row,
          }
        })
      )

      const statusOf = (
        list: typeof result.after,
        setupId: string
      ): string | undefined =>
        list.setups.find((one) => one.setupId === setupId)?.status

      expect(statusOf(result.before, result.setupId)).toBe('suggested')
      expect(statusOf(result.after, result.setupId)).toBe('expired')
      expect(statusOf(result.after, result.confirmedId)).toBe('confirmed')
      // Lazy: the stored column is untouched.
      expect(result.row?.status).toBe('suggested')
    })
  })

  describe('listFor', () => {
    test('newest first, with an empty photo for a profile that has none', async () => {
      const result = await run(
        Effect.gen(function* () {
          const lifecycle = yield* SetupLifecycle
          const db = yield* PgDrizzle.PgDrizzle
          const pair = yield* picked
          const ari = yield* publishFixture('Ari')
          yield* db
            .update(profiles)
            .set({ photoUrl: null })
            .where(eq(profiles.id, ari))

          yield* TestClock.adjust(Duration.minutes(5))
          const newer = yield* lifecycle.expressInterest(
            caller(pair.sigrun),
            ari
          )
          const listed = yield* lifecycle.listFor(caller(pair.sigrun))
          return { ...pair, newer, listed }
        })
      )

      expect(result.listed.setups.map((one) => one.setupId)).toEqual([
        result.newer.setup.setupId,
        result.setupId,
      ])
      expect(result.listed.setups[0]?.counterpart.photoUrl).toBe('')
    })
  })
})
