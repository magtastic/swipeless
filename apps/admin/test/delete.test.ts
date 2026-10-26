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
  makeProfilePhotos,
  memoryBlobStore,
  ProfilePhotos,
  type StoredPhoto,
} from '@swipeless/photos'
import { isNotNull } from 'drizzle-orm'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { deleteProfileAsAdmin, removeProfile } from '../lib/delete.ts'

// Vercel Blob is the one edge substituted: a map stands in for it.
const blobs = new Map<string, StoredPhoto>()
const photosLayer = Layer.succeed(
  ProfilePhotos,
  makeProfilePhotos({
    blobs: memoryBlobStore(blobs),
    download: () => Effect.succeed(undefined),
    secret: 'test-secret',
    baseUrl: 'https://admin.test',
  })
)
const runtime = ManagedRuntime.make(Layer.merge(TestDbLive, photosLayer))

const SUPER = 'magnus@smitten.fun'
const at = Date.parse('2026-10-20T12:00:00Z')
const PHOTO = 'photos/11111111-1111-4111-8111-111111111111.jpeg'

const profile = (index: number) => ({
  tokenHash: `secret-token-${index}`,
  age: 30 + index,
  gender: 'woman' as const,
  interestedIn: ['man' as const],
  city: 'Reykjavík',
  country: 'IS',
  availability: 'Weekends',
  brief: `Brief ${index}`,
  firstName: `Name${index}`,
  phone: `+35482200${index}`,
  photoUrl: PHOTO,
  reviewStatus: 'approved' as const,
  lastSeenAt: new Date(at),
})

/** Two people and a setup between them; returns the first person's id. */
const seed = Effect.gen(function* () {
  const db = yield* PgDrizzle.PgDrizzle
  blobs.set(PHOTO, { bytes: new Uint8Array([1]), contentType: 'image/jpeg' })
  const inserted = yield* db
    .insert(profiles)
    .values([profile(0), { ...profile(1), photoUrl: null }])
    .returning({ id: profiles.id })
  const [a, b] = inserted.map((row) => row.id).sort()
  if (!a || !b) return yield* Effect.dieMessage('insert failed')
  yield* db.insert(setups).values({
    profileAId: a,
    profileBId: b,
    status: 'requested',
    date: {
      venue: { name: 'Kaffihús Vesturbæjar', address: 'Melhagi 20' },
      time: '2026-10-22T19:30:00.000Z',
    },
    confirmedA: true,
    expiresAt: new Date(at + 14 * 86_400_000),
  })
  const [withPhoto] = yield* db
    .select({ id: profiles.id })
    .from(profiles)
    .where(isNotNull(profiles.photoUrl))
  if (!withPhoto) return yield* Effect.dieMessage('insert failed')
  return withPhoto.id
})

const state = Effect.gen(function* () {
  const db = yield* PgDrizzle.PgDrizzle
  return {
    profiles: (yield* db.select({ id: profiles.id }).from(profiles)).map(
      (row) => row.id
    ),
    setups: (yield* db.select({ id: setups.id }).from(setups)).length,
    events: yield* db
      .select({
        kind: adminEvents.kind,
        profileId: adminEvents.profileId,
        payload: adminEvents.payload,
      })
      .from(adminEvents),
    photo: blobs.has(PHOTO),
  }
})

test('a non-super admin is refused without touching the database', async () => {
  const outcome = await deleteProfileAsAdmin(
    '11111111-1111-4111-8111-111111111111',
    'someone@smitten.fun'
  )
  expect(outcome).toEqual({ _tag: 'Forbidden' })
})

describe.skipIf(!hasTestDb)('admin profile delete', () => {
  beforeAll(() => runtime.runPromise(migrate))
  beforeEach(async () => {
    blobs.clear()
    await runtime.runPromise(truncateAll)
  })
  afterAll(() => runtime.dispose())

  test('the super admin deletes the profile, its setups and its photo', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const id = yield* seed
        const outcome = yield* removeProfile(id, SUPER)
        const again = yield* removeProfile(id, SUPER)
        return { id, outcome, again, after: yield* state }
      })
    )
    expect(result.outcome).toEqual({ _tag: 'Deleted' })
    expect(result.again).toEqual({ _tag: 'NotFound' })
    expect(result.after.profiles).toHaveLength(1)
    expect(result.after.profiles).not.toContain(result.id)
    expect(result.after.setups).toBe(0)
    expect(result.after.photo).toBe(false)
    expect(result.after.events).toEqual([
      { kind: 'profile.deleted', profileId: result.id, payload: {} },
    ])
  })

  test('anyone else deletes nothing', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const id = yield* seed
        const outcomes = [
          yield* removeProfile(id, 'someone@smitten.fun'),
          yield* removeProfile(id, null),
        ]
        return { outcomes, after: yield* state }
      })
    )
    expect(result.outcomes).toEqual([
      { _tag: 'Forbidden' },
      { _tag: 'Forbidden' },
    ])
    expect(result.after.profiles).toHaveLength(2)
    expect(result.after.setups).toBe(1)
    expect(result.after.photo).toBe(true)
    expect(result.after.events).toEqual([])
  })
})
