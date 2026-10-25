import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { answerUrl, verifyAnswer } from '../src/answer-links.ts'
import { CELLO_BRIEF, man, ok, profile, publish } from './support/agent.ts'
import { hasTestDb, openApp, warnSkipped } from './support/app.ts'

/**
 * The small yes-or-no page a date request links to, over the whole app:
 * Sigrún's agent picks Jón and she says yes, and Jón answers on the page
 * without an agent. GET only shows; the POST answers through the same
 * confirm and decline the tools call.
 */

// The links sign with the Blob token; Config reads it per call.
process.env.BLOB_READ_WRITE_TOKEN ??= 'test-signing-key'
process.env.API_BASE_URL = 'http://answer.test'

warnSkipped('answer-page.test.ts')

const linkFor = (setupId: string, profileId: string, choice: 'yes' | 'no') =>
  Effect.runPromise(answerUrl(setupId, profileId, choice)).then(
    (url) => new URL(url)
  )

const form = (url: URL, choice: string, sig?: string) =>
  new URLSearchParams({
    setup: url.searchParams.get('setup') ?? '',
    profile: url.searchParams.get('profile') ?? '',
    sig: sig ?? url.searchParams.get('sig') ?? '',
    choice,
  })

test('a link verifies only for its own setup and person', async () => {
  const setupId = '22222222-2222-4222-8222-222222222222'
  const profileId = '11111111-1111-4111-8111-111111111111'
  const url = await linkFor(setupId, profileId, 'yes')
  const sig = url.searchParams.get('sig') ?? ''
  expect(url.origin).toBe('http://answer.test')
  expect(url.pathname).toBe('/answer')
  const check = (setup: string, profile: string, signature: string) =>
    Effect.runPromise(verifyAnswer(setup, profile, signature))
  expect(await check(setupId, profileId, sig)).toBe(true)
  expect(await check(profileId, setupId, sig)).toBe(false)
  expect(await check(setupId, profileId, 'nope')).toBe(false)
})

describe.skipIf(!hasTestDb)('answering a date request on the page', () => {
  const app = openApp()
  beforeEach(app.reset)
  afterAll(app.dispose)

  /** Sigrún picks Jón and says yes, so Jón holds a date request. */
  const requested = async () => {
    const sigrun = await publish(
      app.handler,
      'rest',
      profile({ firstName: 'Sigrún', phone: '+3548221234' })
    )
    const jon = await publish(
      app.handler,
      'rest',
      man({ firstName: 'Jón', phone: '+3546905678', brief: CELLO_BRIEF })
    )
    await app.approve(sigrun.profileId, jon.profileId)
    const { setup } = ok(await sigrun.pick(jon.profileId))
    ok(await sigrun.confirm(setup.setupId))
    return { sigrun, jon, setupId: setup.setupId }
  }

  const page = (path: string, body?: URLSearchParams) =>
    app.handler(
      new Request(`http://localhost${path}`, {
        method: body ? 'POST' : 'GET',
        ...(body ? { body } : {}),
      })
    )

  test('GET shows the note and answers nothing', async () => {
    const { jon, setupId } = await requested()
    const url = await linkFor(setupId, jon.profileId, 'yes')
    const response = await page(`/answer${url.search}`)
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(html).toContain('Sigrún, 34')
    expect(html).toContain('do you want to go out?')
    expect(html).toContain('method="post"')
    const { setups } = ok(await jon.setups())
    expect(setups[0]?.status).toBe('requested')
  })

  test('POST yes confirms as Jón and shows her number', async () => {
    const { jon, setupId } = await requested()
    const url = await linkFor(setupId, jon.profileId, 'yes')
    const html = await (await page('/answer', form(url, 'yes'))).text()
    expect(html).toContain("it's a date!")
    expect(html).toContain('+3548221234')
    const { setups } = ok(await jon.setups())
    expect(setups[0]?.status).toBe('confirmed')
    expect(app.notifications.map((n) => n.kind)).toEqual([
      'dateRequested',
      'dateConfirmed',
      'dateConfirmed',
    ])
  })

  test('POST no declines, and the link is closed after', async () => {
    const { jon, setupId } = await requested()
    const url = await linkFor(setupId, jon.profileId, 'no')
    const html = await (await page('/answer', form(url, 'no'))).text()
    expect(html).toContain('nobody is told why')
    const { setups } = ok(await jon.setups())
    expect(setups[0]?.status).toBe('declined')
    const again = await (await page(`/answer${url.search}`)).text()
    expect(again).toContain('no longer open')
  })

  test('a forged link, or Sigrún’s own, answers nothing', async () => {
    const { sigrun, jon, setupId } = await requested()
    const url = await linkFor(setupId, jon.profileId, 'yes')
    const forged = await page('/answer', form(url, 'yes', '0'.repeat(64)))
    expect(await forged.text()).toContain('no longer open')
    // Her link is valid, but she already said yes.
    const hers = await linkFor(setupId, sigrun.profileId, 'yes')
    expect(await (await page(`/answer${hers.search}`)).text()).toContain(
      'no longer open'
    )
    const { setups } = ok(await jon.setups())
    expect(setups[0]?.status).toBe('requested')
  })

  test('the photo route refuses a forged link and an unsent request', async () => {
    const sigrun = await publish(
      app.handler,
      'rest',
      profile({ firstName: 'Sigrún' })
    )
    const jon = await publish(
      app.handler,
      'rest',
      man({ firstName: 'Jón', brief: CELLO_BRIEF })
    )
    await app.approve(sigrun.profileId, jon.profileId)
    const { setup } = ok(await sigrun.pick(jon.profileId))
    const url = await linkFor(setup.setupId, jon.profileId, 'yes')
    const query = new URLSearchParams({
      setup: setup.setupId,
      profile: jon.profileId,
      sig: url.searchParams.get('sig') ?? '',
    })
    // Still `suggested`: Jón cannot see it, so no photo yet.
    expect((await page(`/answer/photo?${query}`)).status).toBe(404)
    query.set('sig', '0'.repeat(64))
    expect((await page(`/answer/photo?${query}`)).status).toBe(404)
  })
})
