import { describe, expect, test } from 'bun:test'
import { Effect, TestClock, TestContext } from 'effect'
import {
  type DateParty,
  DateSuggester,
  DateSuggesterRules,
} from '../src/date-suggester.ts'

/**
 * The rule-based suggester is pure apart from the clock, so it runs without a
 * database: a real café in Reykjavík, a generic one elsewhere, and a time at
 * least two days out.
 */

/** Monday 2026-10-19 12:00 UTC. */
const MONDAY_NOON = Date.parse('2026-10-19T12:00:00Z')

const party = (
  profileId: string,
  overrides: Partial<DateParty> = {}
): DateParty => ({
  profileId,
  city: 'Reykjavík',
  country: 'IS',
  availability: 'weekday evenings',
  ...overrides,
})

const suggestAt = (at: number, a: DateParty, b: DateParty) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(at)
      const suggester = yield* DateSuggester
      return yield* suggester.suggest({ a, b })
    }).pipe(
      Effect.provide(DateSuggesterRules),
      Effect.provide(TestContext.TestContext)
    )
  )

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

describe('DateSuggesterRules', () => {
  test('suggests a Reykjavík café on the next Thursday evening', async () => {
    const date = await suggestAt(MONDAY_NOON, party(A), party(B))
    expect(date.time).toBe('2026-10-22T19:30:00.000Z')
    expect(date.venue.address).toContain('Reykjavík')
    expect(date.venue.name).not.toContain('A café in the centre')
  })

  test('the same pair gets the same café whoever picked', async () => {
    const one = await suggestAt(MONDAY_NOON, party(A), party(B))
    const two = await suggestAt(MONDAY_NOON, party(B), party(A))
    expect(two.venue).toEqual(one.venue)
  })

  test('two weekend people get Saturday afternoon', async () => {
    const date = await suggestAt(
      MONDAY_NOON,
      party(A, { availability: 'weekends' }),
      party(B, { availability: 'saturday afternoons' })
    )
    expect(date.time).toBe('2026-10-24T15:00:00.000Z')
  })

  test('never sooner than two days out', async () => {
    // Wednesday evening: this Thursday is a day away, so next week's.
    const date = await suggestAt(
      Date.parse('2026-10-21T20:00:00Z'),
      party(A),
      party(B)
    )
    expect(date.time).toBe('2026-10-29T19:30:00.000Z')
  })

  test('a city without curated venues gets a generic café', async () => {
    const date = await suggestAt(
      MONDAY_NOON,
      party(A, { city: 'Akureyri' }),
      party(B, { city: 'Akureyri' })
    )
    expect(date.venue.name).toBe('A café in the centre of Akureyri')
  })
})
