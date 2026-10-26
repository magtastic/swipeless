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
import { Notifier, NotifierLive } from '../src/notifier.ts'
import { Sms, type Text } from '../src/sms.ts'

/**
 * The notifier against a real Postgres, with only Twilio, Resend and the model
 * substituted: it reads the setup and both people itself, so the reads are
 * what is tested.
 */

const FAKE_DATE = {
  venue: { name: 'Kaffihús Vesturbæjar', address: 'Melhagi 20, 107 Reykjavík' },
  time: '2099-09-17T19:30:00.000Z',
}

process.env.API_BASE_URL = 'http://answer.test'
process.env.BLOB_READ_WRITE_TOKEN ??= 'test-signing-key'

const mailer = recordingMailer()
const texts: Array<Text> = []
const runtime = ManagedRuntime.make(
  NotifierLive.pipe(
    Layer.provide(mailer.layer),
    Layer.provide(
      Layer.succeed(
        Sms,
        Sms.of({ send: (text) => Effect.sync(() => void texts.push(text)) })
      )
    ),
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

describe.skipIf(!hasTestDb)('NotifierLive', () => {
  beforeAll(() => runtime.runPromise(migrate))
  beforeEach(async () => {
    mailer.sent.length = 0
    texts.length = 0
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
    expect(email?.text).toContain('Name1, 30, would like to meet you.')
    expect(email?.text).toContain(FAKE_DATE.venue.name)
    expect(email?.text).not.toContain('+35482200')
    expect(email?.text).toContain('you and Name1 both swim in the sea.')

    expect(texts).toHaveLength(1)
    const [text] = texts
    expect(text?.to).toBe('+354822000')
    expect(text?.body).toStartWith(
      'hi Name0, Name1, 30, would like to meet you.'
    )
    expect(text?.body).toContain('you and Name1 both swim in the sea.')
    expect(text?.body).toContain(FAKE_DATE.venue.name)
    expect(text?.body).toContain('yes or no? http://answer.test/answer?')
    expect(text?.body).not.toContain('choice=')
    expect(text?.body).not.toContain('+35482200')
    expect(text?.body).toEndWith('xo, swipeless')
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
    expect(texts[0]?.body).toContain("Name1's number: +354822001")
  })

  test('someone without an email is texted only', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const { setupId, without } = yield* seed
        const notifier = yield* Notifier
        yield* notifier.dateConfirmed(without, setupId)
      })
    )
    expect(mailer.sent).toEqual([])
    expect(texts.map((text) => text.to)).toEqual(['+354822001'])
    expect(texts[0]?.body).toContain("Name0's number: +354822000")
  })

  test('a missing setup tells nobody anything', async () => {
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
    expect(texts).toEqual([])
  })
})
