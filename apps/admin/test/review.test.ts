import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { PgDrizzle } from '@swipeless/db'
import { adminEvents, profiles } from '@swipeless/db/schema'
import {
  hasTestDb,
  migrate,
  TestDbLive,
  truncateAll,
} from '@swipeless/db/testing'
import { asc, eq } from 'drizzle-orm'
import { Effect, ManagedRuntime } from 'effect'
import { decideReview, recordReview, reviewQueue } from '../lib/review.ts'

const runtime = ManagedRuntime.make(TestDbLive)

const SUPER = 'magnus@smitten.fun'
const at = Date.parse('2026-10-20T12:00:00Z')

const profile = (
  index: number,
  overrides: Partial<typeof profiles.$inferInsert> = {}
) => ({
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
  photoUrl: 'photos/11111111-1111-4111-8111-111111111111.jpeg',
  createdAt: new Date(at - index * 60_000),
  lastSeenAt: new Date(at),
  ...overrides,
})

test('a non-super admin is refused without touching the database', async () => {
  const outcome = await recordReview(
    '11111111-1111-4111-8111-111111111111',
    'approved',
    'someone@smitten.fun'
  )
  expect(outcome).toEqual({ _tag: 'Forbidden' })
})

describe.skipIf(!hasTestDb)('admin review queue', () => {
  beforeAll(() => runtime.runPromise(migrate))
  beforeEach(() => runtime.runPromise(truncateAll))
  afterAll(() => runtime.dispose())

  test('lists pending profiles oldest first, note for the super admin only', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* PgDrizzle.PgDrizzle
        yield* db
          .insert(profiles)
          .values([
            profile(0),
            profile(1, { photoUrl: 'https://example.com/a.jpg' }),
            profile(2, { photoUrl: 'javascript:alert(1)' }),
            profile(3, { reviewStatus: 'approved' }),
            profile(4, { reviewStatus: 'rejected' }),
          ])
        return {
          superAdmin: yield* reviewQueue(SUPER),
          ordinary: yield* reviewQueue('someone@smitten.fun'),
        }
      })
    )

    expect(result.superAdmin.canDecide).toBe(true)
    expect(result.superAdmin.hasMore).toBe(false)
    expect(result.superAdmin.pending.map((p) => p.brief)).toEqual([
      'Brief 2',
      'Brief 1',
      'Brief 0',
    ])
    const [oldest, middle, newest] = result.superAdmin.pending
    expect(oldest?.note).toEqual({ firstName: 'Name2', photoUrl: null })
    expect(middle?.note?.photoUrl).toBe('https://example.com/a.jpg')
    expect(newest?.note).toEqual({
      firstName: 'Name0',
      photoUrl: `/api/photos/${newest?.id}`,
    })
    expect(JSON.stringify(result.superAdmin)).not.toContain('+3548')

    expect(result.ordinary.canDecide).toBe(false)
    expect(result.ordinary.pending).toHaveLength(3)
    const serialized = JSON.stringify(result.ordinary)
    for (const hidden of ['Name', '+3548', 'photos/', 'example.com']) {
      expect(serialized).not.toContain(hidden)
    }
  })

  test('approve and reject write the status, the time and an empty event', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* PgDrizzle.PgDrizzle
        const [a, b] = yield* db
          .insert(profiles)
          .values([profile(0), profile(1)])
          .returning({ id: profiles.id })
        if (!a || !b) return yield* Effect.dieMessage('insert failed')

        const approved = yield* decideReview(a.id, 'approved', SUPER)
        const rejected = yield* decideReview(b.id, 'rejected', SUPER)
        const again = yield* decideReview(a.id, 'rejected', SUPER)
        const forbidden = yield* decideReview(b.id, 'approved', 'x@smitten.fun')
        const garbage = yield* decideReview('not-a-uuid', 'approved', SUPER)

        const rows = yield* db
          .select({
            id: profiles.id,
            reviewStatus: profiles.reviewStatus,
            reviewedAt: profiles.reviewedAt,
          })
          .from(profiles)
        const events = yield* db
          .select({
            kind: adminEvents.kind,
            profileId: adminEvents.profileId,
            payload: adminEvents.payload,
          })
          .from(adminEvents)
          .orderBy(asc(adminEvents.kind))
        const queue = yield* reviewQueue(SUPER)
        const statusOf = (id: string) =>
          rows.find((row) => row.id === id)?.reviewStatus
        return {
          a: a.id,
          b: b.id,
          approved,
          rejected,
          again,
          forbidden,
          garbage,
          statusA: statusOf(a.id),
          statusB: statusOf(b.id),
          reviewedAll: rows.every((row) => row.reviewedAt instanceof Date),
          events,
          queue,
        }
      })
    )

    expect(result.approved).toEqual({ _tag: 'Decided', decision: 'approved' })
    expect(result.rejected).toEqual({ _tag: 'Decided', decision: 'rejected' })
    expect(result.again).toEqual({ _tag: 'NotPending' })
    expect(result.forbidden).toEqual({ _tag: 'Forbidden' })
    expect(result.garbage).toEqual({ _tag: 'NotPending' })
    expect(result.statusA).toBe('approved')
    expect(result.statusB).toBe('rejected')
    expect(result.reviewedAll).toBe(true)
    expect(result.events).toEqual([
      { kind: 'profile.approved', profileId: result.a, payload: {} },
      { kind: 'profile.rejected', profileId: result.b, payload: {} },
    ])
    expect(result.queue.pending).toEqual([])
  })

  test('the forbidden path writes nothing', async () => {
    const status = await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* PgDrizzle.PgDrizzle
        const [row] = yield* db
          .insert(profiles)
          .values(profile(0))
          .returning({ id: profiles.id })
        if (!row) return yield* Effect.dieMessage('insert failed')
        yield* decideReview(row.id, 'approved', null)
        const [after] = yield* db
          .select({ reviewStatus: profiles.reviewStatus })
          .from(profiles)
          .where(eq(profiles.id, row.id))
        const events = yield* db.select().from(adminEvents)
        return { status: after?.reviewStatus, events: events.length }
      })
    )
    expect(status).toEqual({ status: 'pending', events: 0 })
  })
})
