import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  HttpLayerRouter,
  HttpServerRequest,
  HttpServerResponse,
} from '@effect/platform'
import { escapeHtml } from '@swipeless/email'
import {
  ConfirmRequest,
  DeclineRequest,
  type ProfileId,
  type SetupId,
} from '@swipeless/shared'
import { Config, Effect, Layer, Option, Redacted } from 'effect'
import { API_BASE_URL } from './answer-links.ts'
import { CurrentProfile } from './caller.ts'
import { declinedText } from './notifier.ts'
import { Swipeless } from './service.ts'

/**
 * A date request is answered by replying to the text (docs/decisions.md,
 * 2026-10-26): Twilio posts each incoming text to `/sms/inbound`. The signed
 * request stands in for the bearer token, the sender's number names the
 * person, and the answer goes through the same `Swipeless.confirm` and
 * `decline` as the small page and the agent tools.
 *
 * The answer is TwiML. A yes that makes it a date answers with nothing,
 * because the notifier already texts both numbers; anything else gets one
 * short line back. Log lines carry no number and no body.
 */

const PATH = '/sms/inbound'

const YES = new Set(['yes', 'y', 'já', 'ja'])
const NO = new Set(['no', 'n', 'nei'])

/** "Yes!", "já." and "  YES " all count; a sentence does not. */
const word = (body: string) =>
  body
    .trim()
    .toLowerCase()
    .replace(/[\s.!?]+$/u, '')

/**
 * Twilio's signature: HMAC-SHA1 of the URL it posted to followed by every
 * form field, sorted by name, each name directly followed by its value.
 */
const twilioSignature = (
  authToken: string,
  url: string,
  params: ReadonlyArray<readonly [string, string]>
) =>
  createHmac('sha1', authToken)
    .update(
      url +
        [...params]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, value]) => name + value)
          .join('')
    )
    .digest('base64')

const signed = (
  authToken: string,
  url: string,
  params: ReadonlyArray<readonly [string, string]>,
  signature: string | undefined
) => {
  if (signature === undefined) return false
  const expected = Buffer.from(twilioSignature(authToken, url, params))
  const given = Buffer.from(signature)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const twiml = (message?: string) =>
  HttpServerResponse.text(
    message === undefined
      ? '<?xml version="1.0" encoding="UTF-8"?><Response/>'
      : `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeHtml(message)}</Message></Response>`,
    { contentType: 'text/xml; charset=utf-8' }
  )

const refused = HttpServerResponse.text('forbidden', { status: 403 })

const NOTHING_OPEN =
  'nothing to answer right now. we will text you when there is someone. xo, swipeless'
const YES_OR_NO = 'reply yes or no. xo, swipeless'

type Service = typeof Swipeless.Service

/** The newest setup waiting for this number's answer, and whose it is. */
const waiting = (swipeless: Service, from: string) =>
  Effect.gen(function* () {
    for (const profileId of yield* swipeless.profilesWithPhone(from)) {
      const { setups } = yield* swipeless
        .setups()
        .pipe(Effect.provideService(CurrentProfile, { profileId }))
      const setup = setups.find(
        (setup) => setup.status === 'requested' && !setup.youConfirmed
      )
      if (setup !== undefined) {
        return Option.some({ profileId, setupId: setup.setupId as SetupId })
      }
    }
    return Option.none<{ profileId: ProfileId; setupId: SetupId }>()
  })

const inbound = (swipeless: Service) =>
  Effect.gen(function* () {
    const authToken = yield* Config.option(Config.redacted('TWILIO_AUTH_TOKEN'))
    if (Option.isNone(authToken)) return yield* refused
    const request = yield* HttpServerRequest.HttpServerRequest
    const params = yield* request.urlParamsBody
    const url = `${yield* API_BASE_URL}${PATH}`
    if (
      !signed(
        Redacted.value(authToken.value),
        url,
        params,
        request.headers['x-twilio-signature']
      )
    ) {
      yield* Effect.logWarning('sms inbound: bad signature')
      return yield* refused
    }
    const field = (name: string) =>
      params.find(([key]) => key === name)?.[1] ?? ''

    const answer = word(field('Body'))
    const choice = YES.has(answer) ? 'yes' : NO.has(answer) ? 'no' : undefined
    const open = yield* waiting(swipeless, field('From'))
    if (Option.isNone(open)) {
      yield* Effect.logInfo('sms inbound: nothing open')
      return yield* twiml(NOTHING_OPEN)
    }
    const { profileId, setupId } = open.value
    const asSender = Effect.provideService(CurrentProfile, { profileId })
    yield* Effect.annotateLogsScoped({ profileId, setupId })

    if (choice === undefined) return yield* twiml(YES_OR_NO)
    if (choice === 'no') {
      yield* swipeless.decline(new DeclineRequest({ setupId })).pipe(asSender)
      yield* Effect.logInfo('sms inbound: declined')
      return yield* twiml(declinedText)
    }
    const result = yield* swipeless
      .confirm(new ConfirmRequest({ setupId }))
      .pipe(asSender)
    yield* Effect.logInfo(`sms inbound: yes, ${result.status}`)
    // Confirmed: the notifier has texted both numbers already.
    return yield* result.status === 'confirmed'
      ? twiml()
      : twiml('got it. we will text you. xo, swipeless')
  }).pipe(
    Effect.scoped,
    Effect.catchAllCause((cause) =>
      Effect.logWarning('sms inbound: failed', cause).pipe(
        Effect.zipRight(twiml(NOTHING_OPEN))
      )
    )
  )

export const SmsInboundRoutes = Layer.unwrapEffect(
  Effect.map(Swipeless, (swipeless) =>
    HttpLayerRouter.add('POST', PATH, inbound(swipeless))
  )
)
