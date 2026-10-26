import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { CELLO_BRIEF, ids, man, ok, profile, publish } from './support/agent.ts'
import { hasTestDb, openApp, warnSkipped } from './support/app.ts'

/**
 * The staged date request for the live demo (docs/decisions.md, 2026-10-26),
 * over the whole app: the presenter publishes from ChatGPT, the prepared
 * match picks him and says yes after the delay, he gets the date request by
 * text, answers yes on the small page, and both get the other's number.
 */

process.env.BLOB_READ_WRITE_TOKEN ??= 'test-signing-key'
process.env.API_BASE_URL = 'http://answer.test'

warnSkipped('showcase.test.ts')

const PRESENTER = '+3548470454'
const MATCH_PHONE = '+15005550006'

describe.skipIf(!hasTestDb)('the showcase date request', () => {
  const app = openApp()
  beforeEach(app.reset)
  afterAll(app.dispose)

  /** The prepared match, published like anyone, then named in the config. */
  const prepare = async () => {
    const katrin = await publish(
      app.handler,
      'rest',
      profile({ firstName: 'Katrín', phone: MATCH_PHONE })
    )
    app.env.set('SHOWCASE_PHONE', PRESENTER)
    app.env.set('SHOWCASE_MATCH_PROFILE_ID', katrin.profileId)
    return katrin
  }

  const answer = (link: string, choice: 'yes' | 'no') => {
    const url = new URL(link)
    const form = new URLSearchParams(url.searchParams)
    form.set('choice', choice)
    return app.handler(
      new Request('http://localhost/answer', { method: 'POST', body: form })
    )
  }

  test('he publishes, is asked by text after the delay, and says yes', async () => {
    const katrin = await prepare()
    const magnus = await publish(
      app.handler,
      'mcp',
      man({ firstName: 'Magnús', phone: PRESENTER, brief: CELLO_BRIEF })
    )

    // Nothing before the delay is up.
    app.travel('29 seconds')
    expect(app.texts).toEqual([])

    app.travel('2 seconds')
    await app.settle()
    expect(app.texts.map((text) => text.to)).toEqual([PRESENTER])
    const request = app.texts[0]?.body ?? ''
    expect(request).toStartWith(
      'hi Magnús, Katrín, 34, would like to meet you.'
    )
    const link = request.match(/http:\/\/answer\.test\/answer\?\S+/)?.[0]
    if (link === undefined) throw new Error(`no link in: ${request}`)

    // His agent sees the same request she made.
    const [setup] = ok(await magnus.setups()).setups
    expect(setup).toMatchObject({
      status: 'requested',
      youConfirmed: false,
      counterpart: { profileId: katrin.profileId, firstName: 'Katrín' },
    })

    // The link opens the page, and his yes there confirms the date.
    const html = await (await answer(link, 'yes')).text()
    expect(html).toContain("it's a date!")
    expect(html).toContain(MATCH_PHONE)
    const confirmations = app.texts.slice(1)
    expect(confirmations.map((text) => text.to).sort()).toEqual(
      [MATCH_PHONE, PRESENTER].sort()
    )
    expect(confirmations.find((text) => text.to === PRESENTER)?.body).toContain(
      `Katrín's number: ${MATCH_PHONE}`
    )
    expect(
      confirmations.find((text) => text.to === MATCH_PHONE)?.body
    ).toContain(`Magnús's number: ${PRESENTER}`)
  })

  test('each rehearsal starts fresh: delete, publish again, asked again', async () => {
    await prepare()
    const first = await publish(
      app.handler,
      'mcp',
      man({ firstName: 'Magnús', phone: PRESENTER })
    )
    app.travel('30 seconds')
    await app.settle()
    const link = app.texts[0]?.body.match(/http:\/\/answer\.test\/\S+/)?.[0]
    if (link === undefined) throw new Error('no first request')
    // He says no this time, then deletes and publishes again.
    await answer(link, 'no')
    ok(await first.remove())

    await publish(
      app.handler,
      'mcp',
      man({ firstName: 'Magnús', phone: PRESENTER })
    )
    app.travel('30 seconds')
    await app.settle()
    expect(app.texts.map((text) => text.to)).toEqual([PRESENTER, PRESENTER])
    expect(app.texts[1]?.body).toContain('Katrín, 34, would like to meet you.')
  })

  test('the match is nobody’s candidate, and nobody else is asked', async () => {
    await prepare()
    const sigrun = await publish(
      app.handler,
      'rest',
      profile({ firstName: 'Sigrún', phone: '+3548221234' })
    )
    const jon = await publish(
      app.handler,
      'rest',
      man({ firstName: 'Jón', phone: '+3546905678' })
    )
    expect(ids(await jon.candidates(10))).toEqual([sigrun.profileId])
    app.travel('1 minute')
    await app.settle()
    expect(app.texts).toEqual([])
  })

  test('off unless the match is set', async () => {
    app.env.set('SHOWCASE_PHONE', PRESENTER)
    await publish(
      app.handler,
      'mcp',
      man({ firstName: 'Magnús', phone: PRESENTER })
    )
    app.travel('1 minute')
    await app.settle()
    expect(app.texts).toEqual([])
  })
})
