import { afterAll, describe, expect, test } from 'bun:test'
import {
  Conflict,
  NotFound,
  PublishResponse,
  RateLimited,
} from '@swipeless/shared'
import { Effect } from 'effect'
import {
  disposeHandlers,
  openHandler,
  type WebHandler,
} from './support/app-handler.ts'
import { GONE_TOKEN, GOOD_TOKEN, UNKNOWN_TOKEN } from './support/fake-caller.ts'
import {
  FAKE_PROFILE_ID,
  FAKE_SETUP_ID,
  fakeApp,
} from './support/fake-swipeless.ts'

/**
 * Transport tests. The service is faked, but routing, schema validation, the
 * bearer middleware and the mapping from a declared failure to an HTTP status
 * all run for real — that mapping is the thing worth proving, because REST and
 * MCP read it out of the same contract.
 */

afterAll(disposeHandlers)

const validProfile = {
  age: 34,
  gender: 'woman',
  interestedIn: ['man', 'non_binary'],
  city: 'Reykjavík',
  country: 'IS',
  radiusKm: 25,
  availability: 'weekday evenings, sunday afternoons',
  brief:
    'She is a hydrologist who reads the weather like other people read faces. ' +
    'She values directness and dislikes being managed. She wants someone who ' +
    'has their own thing going on. Dealbreaker: anyone who calls hiking a ' +
    'hobby and means a car park.',
  firstName: 'Sigrún',
  photoUrl: 'https://example.invalid/sigrun.jpg',
  privateLayer: {
    phone: '+3548221234',
  },
}

/** Drives the same web handler that the Vercel Function exports. */
const request = (handler: WebHandler, path: string, init?: RequestInit) =>
  Effect.promise(() =>
    handler(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${GOOD_TOKEN}`,
          ...init?.headers,
        },
      })
    )
  )

const postJson = (handler: WebHandler, path: string, body: unknown) =>
  request(handler, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('GET /health', () => {
  const handler = openHandler(fakeApp())

  test('returns ok', async () => {
    const res = await Effect.runPromise(request(handler, '/health'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('POST /publish', () => {
  test('rejects an invalid body with 400', async () => {
    const handler = openHandler(fakeApp())
    const res = await Effect.runPromise(
      postJson(handler, '/publish', { ...validProfile, age: 12 })
    )
    expect(res.status).toBe(400)
  })

  test('rejects a profile without a photo with 400', async () => {
    const handler = openHandler(fakeApp())
    const { photoUrl: _photoUrl, ...withoutPhoto } = validProfile
    const res = await Effect.runPromise(
      postJson(handler, '/publish', withoutPhoto)
    )
    expect(res.status).toBe(400)
  })

  test('returns the profileId and token the service issued', async () => {
    const handler = openHandler(
      fakeApp({
        publish: () =>
          Effect.succeed(
            new PublishResponse({
              profileId: FAKE_PROFILE_ID,
              token: 'issued-once',
            })
          ),
      })
    )
    const res = await Effect.runPromise(
      postJson(handler, '/publish', validProfile)
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      profileId: FAKE_PROFILE_ID,
      token: 'issued-once',
    })
  })
})

describe('declared failures map to their status', () => {
  test('401 when the token does not resolve to a profile', async () => {
    const handler = openHandler(fakeApp())
    const res = await Effect.runPromise(
      request(handler, '/candidates', {
        headers: { authorization: `Bearer ${UNKNOWN_TOKEN}` },
      })
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ _tag: 'Unauthorized' })
  })

  test('401 when there is no Authorization header at all', async () => {
    const handler = openHandler(fakeApp())
    const res = await Effect.runPromise(
      Effect.promise(() => handler(new Request('http://localhost/candidates')))
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ _tag: 'Unauthorized' })
  })

  test('410 when the profile has expired', async () => {
    const handler = openHandler(fakeApp())
    const res = await Effect.runPromise(
      request(handler, '/setups', {
        headers: { authorization: `Bearer ${GONE_TOKEN}` },
      })
    )
    expect(res.status).toBe(410)
    expect(await res.json()).toMatchObject({ _tag: 'Gone' })
  })

  test('404 when the interest target is unknown', async () => {
    const handler = openHandler(fakeApp({ interest: () => new NotFound() }))
    const res = await Effect.runPromise(
      postJson(handler, '/interest', { profileId: FAKE_PROFILE_ID })
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ _tag: 'NotFound' })
  })

  test('409 when the setup is in the wrong status, with that status', async () => {
    const handler = openHandler(
      fakeApp({ confirm: () => new Conflict({ status: 'declined' }) })
    )
    const res = await Effect.runPromise(
      postJson(handler, '/confirm', { setupId: FAKE_SETUP_ID })
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      _tag: 'Conflict',
      status: 'declined',
    })
  })

  test('429 when the weekly interest cap is reached, with retry-after', async () => {
    const handler = openHandler(
      fakeApp({
        interest: () => new RateLimited({ retryAfterSeconds: 3600 }),
      })
    )
    const res = await Effect.runPromise(
      postJson(handler, '/interest', { profileId: FAKE_PROFILE_ID })
    )
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({
      _tag: 'RateLimited',
      retryAfterSeconds: 3600,
    })
  })
})

describe('POST /interest', () => {
  test('answers with the whole setup, so the agent can show the note', async () => {
    const handler = openHandler(fakeApp())
    const res = await Effect.runPromise(
      postJson(handler, '/interest', { profileId: FAKE_PROFILE_ID })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      setup: {
        setupId: FAKE_SETUP_ID,
        status: 'suggested',
        youPicked: true,
        counterpart: { firstName: 'Jón' },
        date: { venue: { name: 'Kaffihús Vesturbæjar' } },
      },
    })
  })
})

describe('POST /propose', () => {
  test('is gone: swipeless suggests the date now', async () => {
    const handler = openHandler(fakeApp())
    const res = await Effect.runPromise(
      postJson(handler, '/propose', { setupId: FAKE_SETUP_ID })
    )
    expect(res.status).toBe(404)
  })
})

describe('POST /decline', () => {
  test('returns the settled status', async () => {
    const handler = openHandler(fakeApp())
    const res = await Effect.runPromise(
      postJson(handler, '/decline', { setupId: FAKE_SETUP_ID })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'declined' })
  })

  test('409 when the setup is past declining, with that status', async () => {
    const handler = openHandler(
      fakeApp({ decline: () => new Conflict({ status: 'confirmed' }) })
    )
    const res = await Effect.runPromise(
      postJson(handler, '/decline', { setupId: FAKE_SETUP_ID })
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      _tag: 'Conflict',
      status: 'confirmed',
    })
  })
})

describe('DELETE /profile', () => {
  test('returns 204 and no body', async () => {
    const handler = openHandler(fakeApp())
    const res = await Effect.runPromise(
      request(handler, '/profile', { method: 'DELETE' })
    )
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })
})
