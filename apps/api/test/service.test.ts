import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { PgDrizzle } from '@swipeless/db'
import { adminEvents, profiles, setups } from '@swipeless/db/schema'
import {
  hasTestDb,
  migrate,
  TestDbLive,
  truncateAll,
} from '@swipeless/db/testing'
import {
  ConfirmRequest,
  DeclineRequest,
  InterestRequest,
  PrivateLayer,
  Profile,
  type ProfileId,
} from '@swipeless/shared'
import { and, eq } from 'drizzle-orm'
import {
  Duration,
  Effect,
  Layer,
  ManagedRuntime,
  TestClock,
  TestContext,
} from 'effect'
import { EmbeddingModelDeterministic } from '../src/embeddings.ts'
import { Swipeless } from '../src/service.ts'
import { hashToken } from '../src/token.ts'
import { photoObjects, TestPhotos } from './support/photos.ts'
import { approve } from './support/review.ts'
import { FAKE_DATE, TestSeams } from './support/seams.ts'

/**
 * The service against a real Postgres, through the same interface the REST and
 * MCP adapters use. Only two things are substituted: the database points at
 * TEST_DATABASE_URL, and the embedding model is a hash instead of a network
 * call, so similarity is exactly reproducible.
 */

if (!hasTestDb) {
  console.warn(
    '\n' +
      '  ############################################################\n' +
      '  #  service.test.ts SKIPPED: TEST_DATABASE_URL is not set.  #\n' +
      '  #  Run `bun run test:db` to exercise the database.         #\n' +
      '  ############################################################\n'
  )
}

const TestLayer = Swipeless.Default.pipe(
  Layer.provide(EmbeddingModelDeterministic),
  Layer.provide(TestPhotos),
  Layer.provide(TestSeams),
  Layer.provideMerge(TestDbLive)
)

const runtime = ManagedRuntime.make(TestLayer)

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const HYDROLOGY_BRIEF =
  'She is a hydrologist who reads the weather like other people read faces. ' +
  'She values directness. Dealbreaker: calling a car park a hike.'

const CELLO_BRIEF =
  'He repairs cellos in a basement workshop and cycles everywhere. He values ' +
  'patience and long friendships. Dealbreaker: contempt for slow work.'

type ProfileOverrides = {
  readonly gender?: Profile['gender']
  readonly interestedIn?: Profile['interestedIn']
  readonly country?: string
  readonly brief?: string
  readonly photoUrl?: string
  /** Left pending in the review queue instead of approved. Default false. */
  readonly pending?: boolean
}

const profileFixture = (
  firstName: string,
  overrides: ProfileOverrides = {}
): Profile =>
  new Profile({
    age: 34,
    gender: overrides.gender ?? 'woman',
    interestedIn: overrides.interestedIn ?? ['man'],
    city: 'Reykjavík',
    country: overrides.country ?? 'IS',
    radiusKm: 25,
    availability: 'weekday evenings, sunday afternoons',
    brief: overrides.brief ?? HYDROLOGY_BRIEF,
    firstName,
    photoUrl: overrides.photoUrl ?? `https://example.invalid/${firstName}.jpg`,
    privateLayer: new PrivateLayer({ phone: '+3548221234' }),
  })

/**
 * Publishes a fixture and hands back the id the service issued. Approved
 * unless the test says otherwise, since nobody pending is ever matched.
 */
const publishFixture = (firstName: string, overrides: ProfileOverrides = {}) =>
  Swipeless.pipe(
    Effect.flatMap((service) =>
      service.publish(profileFixture(firstName, overrides))
    ),
    Effect.map((response) => response.profileId),
    Effect.tap((profileId) =>
      overrides.pending === true ? Effect.void : approve(profileId)
    )
  )

/** The pair table enforces profileAId < profileBId; respect it. */
const pairUp = (one: ProfileId, other: ProfileId) =>
  PgDrizzle.PgDrizzle.pipe(
    Effect.flatMap((db) =>
      db.insert(setups).values({
        profileAId: one < other ? one : other,
        profileBId: one < other ? other : one,
        status: 'suggested',
        interestedAAt: new Date('2026-09-10T12:00:00Z'),
        date: { venue: { ...FAKE_DATE.venue }, time: FAKE_DATE.time },
        expiresAt: new Date('2027-01-01T00:00:00Z'),
      })
    )
  )

const candidatesFor = (profileId: ProfileId) =>
  Swipeless.pipe(
    Effect.flatMap((service) => service.candidates({ profileId }, 10))
  )

const describeDb = hasTestDb ? describe : describe.skip

describeDb('Swipeless service', () => {
  beforeAll(() => runtime.runPromise(migrate))
  beforeEach(() => runtime.runPromise(truncateAll))
  afterAll(() => runtime.dispose())

  describe('publish', () => {
    test('stores only the hash of the token it hands back', async () => {
      const stored = await runtime.runPromise(
        Effect.gen(function* () {
          const service = yield* Swipeless
          const db = yield* PgDrizzle.PgDrizzle

          const published = yield* service.publish(profileFixture('Sigrún'))

          const rows = yield* db
            .select({ id: profiles.id, tokenHash: profiles.tokenHash })
            .from(profiles)

          return { published, rows }
        })
      )

      expect(stored.rows).toHaveLength(1)
      expect(stored.rows[0]?.id).toBe(stored.published.profileId)
      expect(stored.rows[0]?.tokenHash).toBe(hashToken(stored.published.token))
      // The token itself must not be recoverable from the row.
      expect(stored.rows[0]?.tokenHash).not.toBe(stored.published.token)
    })

    test('stores only an object key and deletes the image with its profile', async () => {
      const dataUri =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
      await runtime.runPromise(
        Effect.gen(function* () {
          const service = yield* Swipeless
          const db = yield* PgDrizzle.PgDrizzle
          const published = yield* service.publish(
            profileFixture('Test', { photoUrl: dataUri })
          )
          const rows = yield* db
            .select({ photo: profiles.photoUrl })
            .from(profiles)
            .where(eq(profiles.id, published.profileId))
          const key = rows[0]?.photo ?? ''
          expect(key).toMatch(/^photos\//)
          expect(key).not.toContain('base64')
          expect(photoObjects.has(key)).toBe(true)
          yield* service.deleteProfile({ profileId: published.profileId })
          expect(photoObjects.has(key)).toBe(false)
        })
      )
    })

    test('holds a new profile for review, with name and photo stored apart from the phone', async () => {
      const stored = await runtime.runPromise(
        Effect.gen(function* () {
          const service = yield* Swipeless
          const db = yield* PgDrizzle.PgDrizzle
          const published = yield* service.publish(profileFixture('Sigrún'))
          return yield* db
            .select({
              reviewStatus: profiles.reviewStatus,
              reviewedAt: profiles.reviewedAt,
              firstName: profiles.firstName,
              photoUrl: profiles.photoUrl,
              phone: profiles.phone,
            })
            .from(profiles)
            .where(eq(profiles.id, published.profileId))
        })
      )

      expect(stored[0]).toEqual({
        reviewStatus: 'pending',
        reviewedAt: null,
        firstName: 'Sigrún',
        photoUrl: 'https://example.invalid/Sigrún.jpg',
        phone: '+3548221234',
      })
    })

    test('records a signup for the admin site with no personal data', async () => {
      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const service = yield* Swipeless
          const db = yield* PgDrizzle.PgDrizzle

          yield* service.publish(profileFixture('Sigrún'))

          return yield* db
            .select({
              kind: adminEvents.kind,
              payload: adminEvents.payload,
            })
            .from(adminEvents)
        })
      )

      expect(events).toHaveLength(1)
      expect(events[0]?.kind).toBe('profile.published')
      expect(events[0]?.payload).toEqual({ country: 'IS', gender: 'woman' })
    })
  })

  describe('candidates', () => {
    test('applies every hard filter', async () => {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const caller = yield* publishFixture('Sigrún')

          // Mutual interest, same country: the only two that qualify.
          const match = yield* publishFixture('Jón', {
            gender: 'man',
            interestedIn: ['woman'],
          })
          const otherMatch = yield* publishFixture('Ari', {
            gender: 'man',
            interestedIn: ['woman'],
            brief: CELLO_BRIEF,
          })

          // The caller is not interested in women.
          yield* publishFixture('Halla', {
            gender: 'woman',
            interestedIn: ['woman'],
          })
          // Not interested in the caller's gender.
          yield* publishFixture('Björn', {
            gender: 'man',
            interestedIn: ['man'],
          })
          // Right genders, wrong country.
          yield* publishFixture('Tom', {
            gender: 'man',
            interestedIn: ['woman'],
            country: 'GB',
          })
          // Already paired with the caller, so off the list whatever the status.
          const paired = yield* publishFixture('Einar', {
            gender: 'man',
            interestedIn: ['woman'],
          })
          yield* pairUp(caller, paired)

          const response = yield* candidatesFor(caller)
          return { caller, match, otherMatch, response }
        })
      )

      expect(
        [...result.response.candidates].map((one) => one.profileId).sort()
      ).toEqual([result.match, result.otherMatch].sort())
      // Never the caller themselves.
      expect(
        result.response.candidates.some(
          (one) => one.profileId === result.caller
        )
      ).toBe(false)
      // The candidate view carries no radius and no private layer.
      expect(
        Object.keys(result.response.candidates[0]?.core ?? {}).sort()
      ).toEqual(
        [
          'age',
          'gender',
          'interestedIn',
          'city',
          'country',
          'availability',
        ].sort()
      )
    })

    test('only ever returns approved profiles', async () => {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const caller = yield* publishFixture('Sigrún')
          const approved = yield* publishFixture('Jón', {
            gender: 'man',
            interestedIn: ['woman'],
          })
          yield* publishFixture('Ari', {
            gender: 'man',
            interestedIn: ['woman'],
            pending: true,
          })
          const rejected = yield* publishFixture('Einar', {
            gender: 'man',
            interestedIn: ['woman'],
          })
          const db = yield* PgDrizzle.PgDrizzle
          yield* db
            .update(profiles)
            .set({ reviewStatus: 'rejected' })
            .where(eq(profiles.id, rejected))

          const response = yield* candidatesFor(caller)
          return { approved, response }
        })
      )

      expect(result.response.candidates.map((one) => one.profileId)).toEqual([
        result.approved,
      ])
    })

    test('gives a caller still waiting on review an empty list', async () => {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const caller = yield* publishFixture('Sigrún', { pending: true })
          yield* publishFixture('Jón', {
            gender: 'man',
            interestedIn: ['woman'],
          })
          return yield* candidatesFor(caller)
        })
      )

      expect(result.candidates).toEqual([])
    })

    test('an expired setup puts the pair back in play; a no keeps them apart', async () => {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const service = yield* Swipeless
          const caller = yield* publishFixture('Sigrún')
          const expiring = yield* publishFixture('Jón', {
            gender: 'man',
            interestedIn: ['woman'],
          })
          const declining = yield* publishFixture('Ari', {
            gender: 'man',
            interestedIn: ['woman'],
            brief: CELLO_BRIEF,
          })

          yield* service.interest(
            { profileId: caller },
            new InterestRequest({ profileId: expiring })
          )
          const no = yield* service.interest(
            { profileId: caller },
            new InterestRequest({ profileId: declining })
          )
          yield* service.decline(
            { profileId: caller },
            new DeclineRequest({ setupId: no.setup.setupId })
          )

          const before = yield* candidatesFor(caller)
          yield* TestClock.adjust(Duration.days(15))
          const after = yield* candidatesFor(caller)
          return { expiring, before, after }
        }).pipe(Effect.provide(TestContext.TestContext))
      )

      expect(result.before.candidates).toEqual([])
      expect(result.after.candidates.map((one) => one.profileId)).toEqual([
        result.expiring,
      ])
    })

    test('orders by brief similarity, best first', async () => {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const caller = yield* publishFixture('Sigrún')
          const different = yield* publishFixture('Ari', {
            gender: 'man',
            interestedIn: ['woman'],
            brief: CELLO_BRIEF,
          })
          // Byte-identical brief, so cosine distance is exactly 0.
          const identical = yield* publishFixture('Jón', {
            gender: 'man',
            interestedIn: ['woman'],
          })

          const response = yield* candidatesFor(caller)
          return { different, identical, response }
        })
      )

      const ranked = result.response.candidates
      expect(ranked.map((one) => one.profileId)).toEqual([
        result.identical,
        result.different,
      ])
      expect(ranked[0]?.score).toBeCloseTo(1, 5)
      expect(ranked[1]?.score).toBeLessThan(ranked[0]?.score ?? 0)
    })

    test('drops a profile that has not checked in for 90 days', async () => {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const caller = yield* publishFixture('Sigrún')
          yield* publishFixture('Jón', {
            gender: 'man',
            interestedIn: ['woman'],
          })

          const before = yield* candidatesFor(caller)
          yield* TestClock.adjust(Duration.days(91))
          const after = yield* candidatesFor(caller)

          return { before, after }
        }).pipe(Effect.provide(TestContext.TestContext))
      )

      expect(result.before.candidates).toHaveLength(1)
      expect(result.after.candidates).toHaveLength(0)
    })
  })

  describe('deleteProfile', () => {
    test('hard-deletes the row, cascades the setups, and logs the deletion', async () => {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const service = yield* Swipeless
          const db = yield* PgDrizzle.PgDrizzle

          const caller = yield* publishFixture('Sigrún')
          const other = yield* publishFixture('Jón', {
            gender: 'man',
            interestedIn: ['woman'],
          })
          yield* pairUp(caller, other)

          yield* service.deleteProfile({ profileId: caller })

          const remaining = yield* db.select({ id: profiles.id }).from(profiles)
          const pairs = yield* db.select({ id: setups.id }).from(setups)
          const logged = yield* db
            .select({ kind: adminEvents.kind })
            .from(adminEvents)
            .where(
              and(
                eq(adminEvents.kind, 'profile.deleted'),
                eq(adminEvents.profileId, caller)
              )
            )

          return { caller, other, remaining, pairs, logged }
        })
      )

      expect(result.remaining.map((one) => one.id)).toEqual([result.other])
      expect(result.pairs).toHaveLength(0)
      expect(result.logged).toHaveLength(1)
    })
  })

  /**
   * The setup operations are SetupLifecycle's, and its own suite covers the
   * rules. These only prove the service reaches it and hands back what it
   * returns, so a broken wiring cannot pass.
   */
  describe('the setup lifecycle', () => {
    test('carries a pick to a confirmed date', async () => {
      const photoUrl =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const service = yield* Swipeless

          const sigrun = yield* publishFixture('Sigrún', { photoUrl })
          const jon = yield* publishFixture('Jón', {
            photoUrl,
            gender: 'man',
            interestedIn: ['woman'],
          })

          const picked = yield* service.interest(
            { profileId: sigrun },
            new InterestRequest({ profileId: jon })
          )
          const setupId = picked.setup.setupId
          const jonBeforeYes = yield* service.setups({ profileId: jon })

          const requested = yield* service.confirm(
            { profileId: sigrun },
            new ConfirmRequest({ setupId })
          )
          const jonAfterYes = yield* service.setups({ profileId: jon })
          const confirmed = yield* service.confirm(
            { profileId: jon },
            new ConfirmRequest({ setupId })
          )
          const listed = yield* service.setups({ profileId: sigrun })

          return {
            picked,
            jonBeforeYes,
            requested,
            jonAfterYes,
            confirmed,
            listed,
          }
        })
      )

      expect(result.picked.setup.status).toBe('suggested')
      expect(result.picked.setup.counterpart.firstName).toBe('Jón')
      expect(result.picked.setup.counterpart.photoUrl).toMatch(
        /^https:\/\/photos.example\/api\/photos\/.*signature=/
      )
      expect(result.picked.setup.date).toEqual(FAKE_DATE)
      expect(result.jonBeforeYes.setups).toHaveLength(0)
      expect(result.requested.status).toBe('requested')
      expect(result.requested.privateLayer).toBeUndefined()
      expect(result.jonAfterYes.setups[0]?.counterpart.firstName).toBe('Sigrún')
      expect(
        result.jonAfterYes.setups[0]?.counterpartPrivateLayer
      ).toBeUndefined()
      expect(result.confirmed.status).toBe('confirmed')
      expect(result.confirmed.privateLayer?.phone).toBe('+3548221234')
      expect(result.listed.setups[0]?.status).toBe('confirmed')
      expect(result.listed.setups[0]?.counterpartPrivateLayer?.phone).toBe(
        '+3548221234'
      )
    })

    test('reaches the lifecycle to decline a setup', async () => {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const service = yield* Swipeless

          const sigrun = yield* publishFixture('Sigrún')
          const jon = yield* publishFixture('Jón', {
            gender: 'man',
            interestedIn: ['woman'],
          })

          const picked = yield* service.interest(
            { profileId: sigrun },
            new InterestRequest({ profileId: jon })
          )
          const declined = yield* service.decline(
            { profileId: sigrun },
            new DeclineRequest({ setupId: picked.setup.setupId })
          )
          const listed = yield* service.setups({ profileId: sigrun })

          return { declined, listed }
        })
      )

      expect(result.declined.status).toBe('declined')
      expect(result.listed.setups[0]?.status).toBe('declined')
    })

    test("hands the module's failures back unchanged", async () => {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const service = yield* Swipeless
          const one = yield* publishFixture('Sigrún')

          return yield* Effect.flip(
            service.interest(
              { profileId: one },
              new InterestRequest({
                profileId: '00000000-0000-4000-8000-000000000000',
              })
            )
          )
        })
      )

      expect(result._tag).toBe('NotFound')
    })
  })
})
