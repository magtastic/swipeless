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
import { Effect, ManagedRuntime } from 'effect'
import { profileOverviews } from '../lib/dashboard.ts'

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
})
