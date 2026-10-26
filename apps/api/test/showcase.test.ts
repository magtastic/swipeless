import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { CELLO_BRIEF, ids, man, ok, profile, publish } from './support/agent.ts'
import { hasTestDb, openApp, warnSkipped } from './support/app.ts'

/**
 * The staged date request for the live demo (docs/decisions.md, 2026-10-26),
 * over the whole app: the presenter publishes from ChatGPT, the prepared
 * match picks him and says yes after the delay, he gets the date request by
 * text with a short swipeless.me link, says yes on the page, and both get the
 * other's number. The match carries our own Twilio number, which the
 * alphanumeric sender cannot text; that never stops the yes.
 */

process.env.BLOB_READ_WRITE_TOKEN ??= 'test-signing-key'
process.env.API_BASE_URL = 'http://answer.test'

warnSkipped('showcase.test.ts')

const PRESENTER = '+3548470454'
const MATCH_PHONE = '+13347215271'

/** The code in a text's `swipeless.me/a/<code>` link. */
const codeIn = (body: string) =>
  body.match(/swipeless\.me\/a\/([0-9A-Za-z]+)/)?.[1] ?? ''

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

  /** The short link, as swipeless.me proxies it to the API. */
  const short = (code: string, choice?: 'yes' | 'no') =>
    app.handler(
      new Request(`https://api.swipeless.me/a/${code}`, {
        method: choice ? 'POST' : 'GET',
        ...(choice ? { body: new URLSearchParams({ choice }) } : {}),
      })
    )

  test('he publishes, is texted a short link after the delay, and says yes on the page', async () => {
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
      'hi Magnús. Katrín, 34, would like to meet you.'
    )
    expect(request).toEndWith(' xo, swipeless')
    // Carriers drop a text with a scheme in it; a bare link arrives.
    expect(request).not.toContain('https://')
    expect(request).not.toContain('http://')
    expect(request).toMatch(/ swipeless\.me\/a\/[0-9A-Za-z]{14} /)
    expect(request.length).toBeLessThanOrEqual(3 * 67)

    // His agent sees the same request she made.
    const [setup] = ok(await magnus.setups()).setups
    expect(setup).toMatchObject({
      status: 'requested',
      youConfirmed: false,
      counterpart: { profileId: katrin.profileId, firstName: 'Katrín' },
    })

    // The link shows her, and the buttons post back to the same address.
    const code = codeIn(request)
    const shown = await short(code)
    const html = await shown.text()
    expect(shown.status).toBe(200)
    expect(html).toContain('Katrín, 34')
    expect(html).toContain('do you want to go out?')
    expect(html).toContain('you and Katrín both swim in the sea.')
    expect(html).toContain(`action="/a/${code}"`)
    expect(html).not.toContain('name="sig"')
    expect(ok(await magnus.setups()).setups[0]?.status).toBe('requested')

    // His yes makes it a date, and both are texted the other's number.
    const answered = await (await short(code, 'yes')).text()
    expect(answered).toContain("it's a date!")
    expect(answered).toContain(MATCH_PHONE)
    expect(ok(await magnus.setups()).setups[0]?.status).toBe('confirmed')
    expect(app.texts.map((text) => text.to).sort()).toEqual(
      [PRESENTER, PRESENTER, MATCH_PHONE].sort()
    )
    const confirmation = app.texts
      .slice(1)
      .find((text) => text.to === PRESENTER)?.body
    expect(confirmation).toStartWith(
      `it's a date. Katrín's number: ${MATCH_PHONE}.`
    )
    expect(confirmation).not.toContain('swipeless.me')

    // The link now says it is a date, and answers nothing more.
    expect(await (await short(code)).text()).toContain("it's a date with")
  })

  test('an unknown or malformed code is a 404', async () => {
    await prepare()
    await publish(
      app.handler,
      'mcp',
      man({ firstName: 'Magnús', phone: PRESENTER })
    )
    app.travel('30 seconds')
    await app.settle()
    expect((await short('AAAAAAAAAAAAAA')).status).toBe(404)
    expect((await short('nope')).status).toBe(404)
    expect((await short('AAAAAAAAAAAAAA', 'yes')).status).toBe(404)
  })

  test('a failed text never stops the yes', async () => {
    await prepare()
    app.failTexts()
    const magnus = await publish(
      app.handler,
      'mcp',
      man({ firstName: 'Magnús', phone: PRESENTER })
    )
    app.travel('30 seconds')
    await app.settle()
    expect(app.texts).toHaveLength(0)
    const [setup] = ok(await magnus.setups()).setups
    expect(setup?.status).toBe('requested')
    ok(await magnus.confirm(setup?.setupId ?? ''))
    expect(ok(await magnus.setups()).setups[0]?.status).toBe('confirmed')
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
    // He says no this time, then deletes and publishes again.
    const no = await short(codeIn(app.texts[0]?.body ?? ''), 'no')
    expect(await no.text()).toContain('ok. no it is.')
    expect(ok(await first.setups()).setups[0]?.status).toBe('declined')
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
