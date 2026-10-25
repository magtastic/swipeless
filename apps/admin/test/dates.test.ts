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
import { recordingMailer } from '@swipeless/email/testing'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { confirmedDates, followUp, sendFollowUp } from '../lib/dates.ts'

const mailer = recordingMailer()
const runtime = ManagedRuntime.make(Layer.merge(TestDbLive, mailer.layer))

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
  reviewStatus: 'approved' as const,
  lastSeenAt: new Date(at),
  ...overrides,
})

const date = (time: string) => ({
  venue: { name: 'Kaffihús Vesturbæjar', address: 'Melhagi 20' },
  time,
})

/** Two people and a setup between them, ordered as the table requires. */
const pair = (
  status: 'confirmed' | 'requested',
  emails: readonly [string | null, string | null],
  time = '2026-10-22T19:30:00.000Z',
  offset = 0
) =>
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle
    const inserted = yield* db
      .insert(profiles)
      .values([
        profile(offset, { email: emails[0] }),
        profile(offset + 1, { email: emails[1] }),
      ])
      .returning({ id: profiles.id, firstName: profiles.firstName })
    const [a, b] = inserted.sort((x, y) => (x.id < y.id ? -1 : 1))
    if (!a || !b) return yield* Effect.dieMessage('insert failed')
    const [row] = yield* db
      .insert(setups)
      .values({
        profileAId: a.id,
        profileBId: b.id,
        status,
        date: date(time),
        confirmedA: true,
        confirmedB: status === 'confirmed',
        expiresAt: new Date(at + 14 * 86_400_000),
      })
      .returning({ id: setups.id })
    if (!row) return yield* Effect.dieMessage('insert failed')
    return { setupId: row.id, a, b }
  })

test('a non-super admin is refused without touching the database', async () => {
  const outcome = await sendFollowUp(
    '11111111-1111-4111-8111-111111111111',
    'someone@smitten.fun'
  )
  expect(outcome).toEqual({ _tag: 'Forbidden' })
})

describe.skipIf(!hasTestDb)('confirmed dates and the follow-up', () => {
  beforeAll(() => runtime.runPromise(migrate))
  beforeEach(async () => {
    mailer.sent.length = 0
    await runtime.runPromise(truncateAll)
  })
  afterAll(() => runtime.dispose())

  test('lists confirmed setups only, latest date first, names for the super admin', async () => {
    const { superView, plainView, early, late } = await runtime.runPromise(
      Effect.gen(function* () {
        const early = yield* pair(
          'confirmed',
          ['a@example.com', null],
          '2026-10-21T19:30:00.000Z',
          0
        )
        const late = yield* pair(
          'confirmed',
          [null, null],
          '2026-10-24T15:00:00.000Z',
          2
        )
        yield* pair('requested', ['c@example.com', null], undefined, 4)
        return {
          early,
          late,
          superView: yield* confirmedDates(SUPER),
          plainView: yield* confirmedDates('someone@smitten.fun'),
        }
      })
    )
    expect(superView.canSend).toBe(true)
    expect(superView.dates.map((row) => row.id)).toEqual([
      late.setupId,
      early.setupId,
    ])
    expect(superView.dates[1]?.people?.map((p) => p.hasEmail).sort()).toEqual([
      false,
      true,
    ])
    expect(plainView.canSend).toBe(false)
    expect(plainView.dates.every((row) => row.people === undefined)).toBe(true)
    expect(JSON.stringify(plainView)).not.toContain('Name')
  })

  test('emails each person who gave an address, once, naming the other', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const { setupId, a, b } = yield* pair('confirmed', [
          'a@example.com',
          'b@example.com',
        ])
        const first = yield* followUp(setupId, SUPER)
        const again = yield* followUp(setupId, SUPER)
        const db = yield* PgDrizzle.PgDrizzle
        const events = yield* db
          .select({ kind: adminEvents.kind, payload: adminEvents.payload })
          .from(adminEvents)
        const listed = yield* confirmedDates(SUPER)
        return { setupId, a, b, first, again, events, listed }
      })
    )
    expect(result.first).toEqual({ _tag: 'Sent', emailed: 2 })
    expect(result.again).toEqual({ _tag: 'NotSendable' })
    expect(mailer.sent).toHaveLength(2)
    expect(
      mailer.sent.every((email) => email.subject === 'how was the date?')
    ).toBe(true)
    // Name0 gave a@, Name1 gave b@. Each email names the other person.
    const byRecipient = new Map(mailer.sent.map((email) => [email.to, email]))
    expect(byRecipient.get('a@example.com')?.text).toContain(
      'how was the date with Name1?'
    )
    expect(byRecipient.get('b@example.com')?.text).toContain(
      'how was the date with Name0?'
    )
    expect(result.events).toEqual([
      {
        kind: 'setup.follow_up_sent',
        payload: { setupId: result.setupId, emailed: 2 },
      },
    ])
    expect(result.listed.dates[0]?.followUpSentAt).not.toBeNull()
  })

  test('an upcoming confirmed date can be asked about too', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const upcoming = yield* pair(
          'confirmed',
          ['a@example.com', null],
          '2099-09-17T19:30:00.000Z'
        )
        return yield* followUp(upcoming.setupId, SUPER)
      })
    )
    expect(result).toEqual({ _tag: 'Sent', emailed: 1 })
    expect(mailer.sent).toHaveLength(1)
  })

  test('refuses unconfirmed setups and pairs with no email, writing nothing', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const requested = yield* pair('requested', ['a@example.com', null])
        const silent = yield* pair('confirmed', [null, ''], undefined, 2)
        return {
          requested: yield* followUp(requested.setupId, SUPER),
          silent: yield* followUp(silent.setupId, SUPER),
          garbage: yield* followUp('not-a-uuid', SUPER),
          forbidden: yield* followUp(silent.setupId, null),
        }
      })
    )
    expect(result).toEqual({
      requested: { _tag: 'NotSendable' },
      silent: { _tag: 'NoEmail' },
      garbage: { _tag: 'NotSendable' },
      forbidden: { _tag: 'Forbidden' },
    })
    expect(mailer.sent).toEqual([])
  })
})
