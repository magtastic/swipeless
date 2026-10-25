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
import { Effect, ManagedRuntime } from 'effect'
import { countSetups, profileOverviews } from '../lib/dashboard.ts'

const runtime = ManagedRuntime.make(TestDbLive)

describe.skipIf(!hasTestDb)('admin profile overviews', () => {
  beforeAll(() => runtime.runPromise(migrate))
  beforeEach(() => runtime.runPromise(truncateAll))
  afterAll(() => runtime.dispose())

  test('paginates published fields and excludes private data', async () => {
    const at = Date.parse('2026-09-15T12:00:00Z')
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* PgDrizzle.PgDrizzle
        yield* db.insert(profiles).values(
          Array.from({ length: 21 }, (_, index) => ({
            tokenHash: `secret-token-${index}`,
            age: 33,
            gender: 'man' as const,
            interestedIn: ['woman' as const],
            city: 'Reykjavík',
            country: 'IS',
            availability: 'Sunday afternoons',
            brief: `Published brief ${index}`,
            firstName: 'Private name',
            phone: '+3548221234',
            email: 'private@example.com',
            photoUrl: 'photos/11111111-1111-4111-8111-111111111111.jpeg',
            standingInstructions: 'Private instructions',
            createdAt: new Date(at - index * 1000),
            lastSeenAt: new Date(at - (index === 20 ? 90 * 86400000 : 0)),
          }))
        )
        return {
          superAdmin: yield* profileOverviews(at, 1, 'magnus@smitten.fun'),
          ordinaryAdmin: yield* profileOverviews(at, 1, 'another@smitten.fun'),
          otherMagnus: yield* profileOverviews(at, 1, 'magnus@smitten.co'),
          first: yield* profileOverviews(at, 1),
          second: yield* profileOverviews(at, 2),
          empty: yield* profileOverviews(at, 3),
        }
      })
    )
    expect(result.first.overviews).toHaveLength(20)
    expect(result.first.hasMoreProfiles).toBe(true)
    expect(result.first.overviews[0]?.brief).toBe('Published brief 0')
    expect(result.first.overviews[0]?.expired).toBe(false)
    expect(result.second.overviews).toHaveLength(1)
    expect(result.second.overviews[0]?.brief).toBe('Published brief 20')
    expect(result.second.overviews[0]?.expired).toBe(true)
    expect(result.second.hasMoreProfiles).toBe(false)
    expect(result.empty.overviews).toEqual([])
    expect(result.first.overviews[0]?.reviewStatus).toBe('pending')
    expect(result.superAdmin.overviews[0]?.note).toEqual({
      firstName: 'Private name',
      photoUrl: `/api/photos/${result.superAdmin.overviews[0]?.id}`,
    })
    expect(result.superAdmin.overviews[0]?.privateDetails).toEqual({
      phone: '+3548221234',
      email: 'private@example.com',
      standingInstructions: 'Private instructions',
    })
    expect(JSON.stringify(result.superAdmin)).not.toContain('secret-token')
    const { superAdmin: _, ...publicResults } = result
    const serialized = JSON.stringify(publicResults)
    for (const privateValue of [
      'secret-token',
      'Private name',
      '+3548221234',
      'private@example.com',
      'photos/11111111-1111-4111-8111-111111111111.jpeg',
      'Private instructions',
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
  })

  /**
   * The console counts what the agents see: an unsettled setup whose
   * suggested time has passed is expired, as in `setups.ts`, while a
   * confirmed or declined one keeps its status after the date.
   */
  test('counts setups by effective status, date time included', async () => {
    const at = Date.parse('2026-09-15T12:00:00Z')
    const past = new Date(at - 60 * 60 * 1000)
    const future = new Date(at + 7 * 86400000)
    const date = (time: Date) => ({
      venue: { name: 'Mokka Kaffi', address: 'Skólavörðustígur 3a' },
      time: time.toISOString(),
    })

    const counts = await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* PgDrizzle.PgDrizzle
        const people = yield* db
          .insert(profiles)
          .values(
            Array.from({ length: 4 }, (_, index) => ({
              tokenHash: `token-${index}`,
              age: 33,
              gender: 'man' as const,
              interestedIn: ['woman' as const],
              city: 'Reykjavík',
              country: 'IS',
              availability: 'Sunday afternoons',
              brief: `Brief ${index}`,
              firstName: 'Name',
              phone: '+3548221234',
              lastSeenAt: new Date(at),
            }))
          )
          .returning({ id: profiles.id })
        const ids = people.map((one) => one.id).sort()
        const pair = (a: number, b: number) => ({
          profileAId: ids[a] ?? '',
          profileBId: ids[b] ?? '',
        })

        yield* db.insert(setups).values([
          // Live: still suggested.
          {
            ...pair(0, 1),
            status: 'suggested' as const,
            date: date(future),
            expiresAt: future,
          },
          // The suggested time passed without both yeses.
          {
            ...pair(0, 2),
            status: 'requested' as const,
            date: date(past),
            expiresAt: future,
          },
          // Fourteen days without a transition.
          {
            ...pair(0, 3),
            status: 'suggested' as const,
            date: date(future),
            expiresAt: past,
          },
          // Settled statuses keep theirs after the date.
          {
            ...pair(1, 2),
            status: 'confirmed' as const,
            date: date(past),
            expiresAt: past,
          },
          {
            ...pair(1, 3),
            status: 'declined' as const,
            date: date(past),
            expiresAt: future,
          },
        ])
        return yield* countSetups(at)
      })
    )

    expect(Object.fromEntries(counts.map((c) => [c.status, c.count]))).toEqual({
      suggested: 1,
      requested: 0,
      confirmed: 1,
      declined: 1,
      expired: 2,
    })
  })
})
