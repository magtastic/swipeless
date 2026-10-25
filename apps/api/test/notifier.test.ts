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
import { recordingMailer } from '@swipeless/email/testing'
import type { ProfileId, SetupId } from '@swipeless/shared'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { FitWriter } from '../src/fit-writer.ts'
import { Notifier, NotifierEmail } from '../src/notifier.ts'

/**
 * The email notifier against a real Postgres, with only the mailer faked: it
 * reads the setup and both people itself, so the reads are what is tested.
 */

const FAKE_DATE = {
  venue: { name: 'Kaffihús Vesturbæjar', address: 'Melhagi 20, 107 Reykjavík' },
  time: '2099-09-17T19:30:00.000Z',
}

const mailer = recordingMailer()
const runtime = ManagedRuntime.make(
  NotifierEmail.pipe(
    Layer.provide(mailer.layer),
    Layer.provide(
      Layer.succeed(
        FitWriter,
        FitWriter.of({
          whyYouFit: ({ otherFirstName }) =>
            Effect.succeed(`you and ${otherFirstName} both swim in the sea.`),
        })
      )
    ),
    Layer.provideMerge(TestDbLive)
  )
)

const person = (index: number, email: string | null) => ({
  tokenHash: `notifier-token-${index}`,
  age: 30,
  gender: 'woman' as const,
  interestedIn: ['man' as const],
  city: 'Reykjavík',
  country: 'IS',
  availability: 'Weekends',
  brief: `Brief ${index}`,
  firstName: `Name${index}`,
  phone: `+35482200${index}`,
  email,
  reviewStatus: 'approved' as const,
})

/** A setup between Name0 (with an email) and Name1 (without one). */
const seed = Effect.gen(function* () {
  const db = yield* PgDrizzle.PgDrizzle
  const inserted = yield* db
    .insert(profiles)
    .values([person(0, 'name0@example.com'), person(1, null)])
    .returning({ id: profiles.id, firstName: profiles.firstName })
  const [a, b] = inserted.sort((x, y) => (x.id < y.id ? -1 : 1))
  if (!a || !b) return yield* Effect.dieMessage('insert failed')
  const [row] = yield* db
    .insert(setups)
    .values({
      profileAId: a.id,
      profileBId: b.id,
      status: 'requested',
      date: FAKE_DATE,
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    })
    .returning({ id: setups.id })
  if (!row) return yield* Effect.dieMessage('insert failed')
  const withEmail = inserted.find((p) => p.firstName === 'Name0')
  const without = inserted.find((p) => p.firstName === 'Name1')
  if (!withEmail || !without) return yield* Effect.dieMessage('insert failed')
  return {
    setupId: row.id as SetupId,
    withEmail: withEmail.id as ProfileId,
    without: without.id as ProfileId,
  }
})

describe.skipIf(!hasTestDb)('NotifierEmail', () => {
  beforeAll(() => runtime.runPromise(migrate))
  beforeEach(async () => {
    mailer.sent.length = 0
    await runtime.runPromise(truncateAll)
  })
  afterAll(() => runtime.dispose())

  test('the date request names the other person, the place and the time', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const { setupId, withEmail } = yield* seed
        const notifier = yield* Notifier
        yield* notifier.dateRequested(withEmail, setupId)
      })
    )
    expect(mailer.sent).toHaveLength(1)
    const [email] = mailer.sent
    expect(email?.to).toBe('name0@example.com')
    expect(email?.subject).toBe('Name1 would like to meet you')
    expect(email?.text).toContain(FAKE_DATE.venue.name)
    expect(email?.text).not.toContain('+35482200')
    expect(email?.text).toContain('you and Name1 both swim in the sea.')
  })

  test('the confirmation carries the other phone number', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const { setupId, withEmail } = yield* seed
        const notifier = yield* Notifier
        yield* notifier.dateConfirmed(withEmail, setupId)
      })
    )
    expect(mailer.sent[0]?.text).toContain("Name1's number: +354822001")
  })

  test('someone without an email, or a missing setup, gets nothing', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const { without, withEmail } = yield* seed
        const notifier = yield* Notifier
        const setupId = crypto.randomUUID() as SetupId
        yield* notifier.dateConfirmed(without, setupId)
        yield* notifier.dateRequested(withEmail, setupId)
      })
    )
    expect(mailer.sent).toEqual([])
  })
})
