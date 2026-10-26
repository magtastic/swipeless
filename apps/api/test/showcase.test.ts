import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { CELLO_BRIEF, ids, man, ok, profile, publish } from './support/agent.ts'
import { hasTestDb, openApp, warnSkipped } from './support/app.ts'

/**
 * The staged date request for the live demo (docs/decisions.md, 2026-10-26),
 * over the whole app: the presenter publishes from ChatGPT, the prepared
 * match picks him and says yes after the delay, he gets the date request by
 * text, answers by replying yes, and both get the other's number. The match
 * carries our own Twilio number, which is never texted.
 */

process.env.BLOB_READ_WRITE_TOKEN ??= 'test-signing-key'
process.env.API_BASE_URL = 'http://answer.test'

warnSkipped('showcase.test.ts')

const PRESENTER = '+3548470454'
const MATCH_PHONE = '+13347215271'
const AUTH_TOKEN = 'test-twilio-token'
const INBOUND_URL = 'http://answer.test/sms/inbound'

/** Signs a form the way Twilio does: the URL, then each field sorted by name. */
const twilioSign = (url: string, form: URLSearchParams, token = AUTH_TOKEN) =>
  createHmac('sha1', token)
    .update(
      url +
        [...form]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([name, value]) => name + value)
          .join('')
    )
    .digest('base64')

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
    app.env.set('SMS_FROM', MATCH_PHONE)
    app.env.set('TWILIO_AUTH_TOKEN', AUTH_TOKEN)
    return katrin
  }

  /** A text from `from`, as Twilio posts it to the webhook. */
  const reply = (body: string, from = PRESENTER, token = AUTH_TOKEN) => {
    const form = new URLSearchParams({
      MessageSid: 'SM00000000000000000000000000000000',
      From: from,
      To: MATCH_PHONE,
      Body: body,
    })
    return app.handler(
      new Request('https://api.swipeless.me/sms/inbound', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': twilioSign(INBOUND_URL, form, token),
        },
        body: form,
      })
    )
  }

  test('he publishes, is asked by text after the delay, and replies yes', async () => {
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
    expect(request).toEndWith('reply yes or no. xo, swipeless')
    // Carriers drop a text with a link in it.
    expect(request).not.toMatch(/https?:|\.\w{2,3}\//)
    expect(request.length).toBeLessThanOrEqual(3 * 67)

    // His agent sees the same request she made.
    const [setup] = ok(await magnus.setups()).setups
    expect(setup).toMatchObject({
      status: 'requested',
      youConfirmed: false,
      counterpart: { profileId: katrin.profileId, firstName: 'Katrín' },
    })

    // His reply confirms the date. The notifier texts him her number, so
    // the webhook answers with nothing, and our own number is not texted.
    const response = await reply('Já!')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<Response/>')
    expect(app.texts.map((text) => text.to)).toEqual([PRESENTER, PRESENTER])
    expect(app.texts[1]?.body).toStartWith(
      `it's a date. Katrín's number: ${MATCH_PHONE}.`
    )
    expect(ok(await magnus.setups()).setups[0]?.status).toBe('confirmed')

    // Nothing is left to answer.
    expect(await (await reply('yes')).text()).toContain('nothing to answer')
  })

  test('an unsigned or wrongly signed text is refused', async () => {
    await prepare()
    const magnus = await publish(
      app.handler,
      'mcp',
      man({ firstName: 'Magnús', phone: PRESENTER })
    )
    app.travel('30 seconds')
    await app.settle()

    expect((await reply('yes', PRESENTER, 'not-the-token')).status).toBe(403)
    const unsigned = await app.handler(
      new Request('https://api.swipeless.me/sms/inbound', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: PRESENTER, Body: 'yes' }),
      })
    )
    expect(unsigned.status).toBe(403)
    expect(ok(await magnus.setups()).setups[0]?.status).toBe('requested')
    expect(app.texts).toHaveLength(1)
  })

  test('anything but yes or no is asked again', async () => {
    await prepare()
    const magnus = await publish(
      app.handler,
      'mcp',
      man({ firstName: 'Magnús', phone: PRESENTER })
    )
    app.travel('30 seconds')
    await app.settle()
    expect(await (await reply('maybe?')).text()).toContain('reply yes or no.')
    expect(ok(await magnus.setups()).setups[0]?.status).toBe('requested')
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
    expect(await (await reply('nei')).text()).toContain('ok, no it is.')
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
