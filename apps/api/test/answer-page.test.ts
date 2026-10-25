import { afterAll, expect, test } from 'bun:test'
import {
  ConfirmResponse,
  PrivateLayer,
  Setup,
  SetupsResponse,
} from '@swipeless/shared'
import { Effect } from 'effect'
import { answerUrl, verifyAnswer } from '../src/answer-links.ts'
import { disposeHandlers, openHandler } from './support/app-handler.ts'
import {
  FAKE_PROFILE_ID,
  FAKE_SETUP,
  FAKE_SETUP_ID,
  fakeApp,
} from './support/fake-swipeless.ts'

/**
 * The small yes-or-no page over a fake service: the signed link, the GET that
 * only shows, and the POST that answers through `confirm` or `decline`.
 */

// The links sign with the Blob token; Config reads it per call.
process.env.BLOB_READ_WRITE_TOKEN ??= 'test-signing-key'
process.env.API_BASE_URL = 'http://answer.test'

afterAll(disposeHandlers)

/** The picked person's view: the other side said yes, this side has not. */
const REQUESTED = new Setup({
  ...FAKE_SETUP,
  status: 'requested',
  youPicked: false,
})

const linkFor = (choice: 'yes' | 'no') =>
  Effect.runPromise(answerUrl(FAKE_SETUP_ID, FAKE_PROFILE_ID, choice)).then(
    (url) => new URL(url)
  )

const form = (url: URL, choice: string) =>
  new URLSearchParams({
    setup: url.searchParams.get('setup') ?? '',
    profile: url.searchParams.get('profile') ?? '',
    sig: url.searchParams.get('sig') ?? '',
    choice,
  })

test('a link verifies only for its own setup and person', async () => {
  const url = await linkFor('yes')
  const sig = url.searchParams.get('sig') ?? ''
  expect(url.origin).toBe('http://answer.test')
  expect(url.pathname).toBe('/answer')
  const check = (setup: string, profile: string, signature: string) =>
    Effect.runPromise(verifyAnswer(setup, profile, signature))
  expect(await check(FAKE_SETUP_ID, FAKE_PROFILE_ID, sig)).toBe(true)
  expect(
    await check(FAKE_SETUP_ID, FAKE_SETUP.counterpart.profileId, sig)
  ).toBe(false)
  expect(await check(FAKE_SETUP_ID, FAKE_PROFILE_ID, 'nope')).toBe(false)
})

test('GET shows the note and answers nothing', async () => {
  let confirmed = 0
  const handler = openHandler(
    fakeApp({
      setups: () => Effect.succeed(new SetupsResponse({ setups: [REQUESTED] })),
      confirm: () =>
        Effect.sync(() => {
          confirmed += 1
          return new ConfirmResponse({ status: 'confirmed' })
        }),
    })
  )
  const url = await linkFor('yes')
  const response = await handler(
    new Request(`http://localhost/answer${url.search}`)
  )
  const html = await response.text()
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(html).toContain('Jón, 36')
  expect(html).toContain('do you want to go out?')
  expect(html).toContain('method="post"')
  expect(confirmed).toBe(0)
})

test('a tampered link shows the closed page and never answers', async () => {
  let declined = 0
  const handler = openHandler(
    fakeApp({
      setups: () => Effect.succeed(new SetupsResponse({ setups: [REQUESTED] })),
      decline: () =>
        Effect.sync(() => {
          declined += 1
          return { status: 'declined' } as never
        }),
    })
  )
  const url = await linkFor('no')
  const body = form(url, 'no')
  body.set('sig', '0'.repeat(64))
  const response = await handler(
    new Request('http://localhost/answer', { method: 'POST', body })
  )
  expect(await response.text()).toContain('no longer open')
  expect(declined).toBe(0)
})

test('POST yes confirms as the linked person and shows the number', async () => {
  const callers: Array<string> = []
  const handler = openHandler(
    fakeApp({
      setups: () => Effect.succeed(new SetupsResponse({ setups: [REQUESTED] })),
      confirm: (caller, request) =>
        Effect.sync(() => {
          callers.push(`${caller.profileId}:${request.setupId}`)
          return new ConfirmResponse({
            status: 'confirmed',
            privateLayer: new PrivateLayer({ phone: '+3545550101' }),
          })
        }),
    })
  )
  const url = await linkFor('yes')
  const response = await handler(
    new Request('http://localhost/answer', {
      method: 'POST',
      body: form(url, 'yes'),
    })
  )
  const html = await response.text()
  expect(callers).toEqual([`${FAKE_PROFILE_ID}:${FAKE_SETUP_ID}`])
  expect(html).toContain("it's a date!")
  expect(html).toContain('+3545550101')
})

test('a setup already answered shows the closed page', async () => {
  const handler = openHandler(
    fakeApp({
      setups: () =>
        Effect.succeed(
          new SetupsResponse({
            setups: [new Setup({ ...REQUESTED, youConfirmed: true })],
          })
        ),
    })
  )
  const url = await linkFor('yes')
  const response = await handler(
    new Request(`http://localhost/answer${url.search}`)
  )
  expect(await response.text()).toContain('no longer open')
})

test('the photo route refuses a bad signature and an unsent request', async () => {
  const handler = openHandler(
    fakeApp({
      setups: () =>
        Effect.succeed(new SetupsResponse({ setups: [FAKE_SETUP] })),
    })
  )
  const url = await linkFor('yes')
  const query = new URLSearchParams({
    setup: url.searchParams.get('setup') ?? '',
    profile: url.searchParams.get('profile') ?? '',
    sig: url.searchParams.get('sig') ?? '',
  })
  // FAKE_SETUP is still `suggested`: no photo before the request is sent.
  const early = await handler(
    new Request(`http://localhost/answer/photo?${query}`)
  )
  expect(early.status).toBe(404)
  query.set('sig', '0'.repeat(64))
  const forged = await handler(
    new Request(`http://localhost/answer/photo?${query}`)
  )
  expect(forged.status).toBe(404)
})
