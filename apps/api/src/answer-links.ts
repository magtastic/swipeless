import { createHmac, timingSafeEqual } from 'node:crypto'
import { Config, Effect, Redacted } from 'effect'

/**
 * Signed links to the small yes-or-no page. PRODUCT.md, SMS, email and small
 * pages: "When something needs a tap (…, yes or no, …), the message links a
 * small single-purpose page. Nothing to download, no login."
 *
 * The signature binds one setup to one person, so a link answers only for the
 * person it was sent to. It carries no expiry: the setup's own state decides
 * whether an answer still counts. The key is the one photo links sign with
 * (`PHOTO_LINK_SECRET`, or the Blob token until that is set), kept apart by
 * the `answer:` prefix, so the page needs no new secret. Config is read per call, not at layer build, so the transport
 * tests can build the routes without it.
 */

export const API_BASE_URL = Config.string('API_BASE_URL').pipe(
  Config.withDefault('https://api.swipeless.me')
)

/** The photo links' key, so every link swipeless signs shares one secret. */
const secret = Config.redacted('PHOTO_LINK_SECRET').pipe(
  Config.orElse(() => Config.redacted('BLOB_READ_WRITE_TOKEN')),
  Effect.map(Redacted.value)
)

const sign = (key: string, setupId: string, profileId: string) =>
  createHmac('sha256', key)
    .update(`answer:${setupId.toLowerCase()}:${profileId.toLowerCase()}`)
    .digest('hex')

export type Choice = 'yes' | 'no'

/**
 * The page's URL for this person and setup, with an answer picked in advance
 * or none.
 */
export const answerUrl = (
  setupId: string,
  profileId: string,
  choice?: Choice
) =>
  Effect.gen(function* () {
    const base = yield* API_BASE_URL
    const signature = sign(yield* secret, setupId, profileId)
    const query = new URLSearchParams({
      setup: setupId,
      profile: profileId,
      sig: signature,
      ...(choice ? { choice } : {}),
    })
    return `${base}/answer?${query}`
  })

/** Whether `signature` was made for exactly this setup and person. */
export const verifyAnswer = (
  setupId: string,
  profileId: string,
  signature: string
) =>
  Effect.map(secret, (key) => {
    if (!/^[a-f0-9]{64}$/.test(signature)) return false
    return timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(sign(key, setupId, profileId), 'hex')
    )
  })

/**
 * The short link a text carries: `swipeless.me/a/<code>`, written without a
 * scheme, because Icelandic carriers silently drop a text with `https://` in
 * it (docs/decisions.md, 2026-10-26). swipeless.me proxies `/a/*` to this
 * API, so the page keeps the short address.
 *
 * The code is derived, not stored: the first 14 base62 characters of an HMAC
 * over the setup and the person, about 83 bits, so it stands in for the
 * signature exactly as `sig` does. The page finds its setup by deriving the
 * code for every open pair (`Swipeless.answerablePairs`), few at a time.
 */
const WEB_HOST = Config.string('WEB_HOST').pipe(
  Config.withDefault('swipeless.me')
)

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const CODE_LENGTH = 14

export const isAnswerCode = (code: string) =>
  new RegExp(`^[0-9A-Za-z]{${CODE_LENGTH}}$`).test(code)

export const answerCode = (setupId: string, profileId: string) =>
  Effect.map(secret, (key) =>
    [
      ...createHmac('sha256', key)
        .update(
          `answer-code:${setupId.toLowerCase()}:${profileId.toLowerCase()}`
        )
        .digest()
        .subarray(0, CODE_LENGTH),
    ]
      .map((byte) => BASE62[byte % 62])
      .join('')
  )

/** `swipeless.me/a/<code>`, no scheme, for a text. */
export const shortAnswerLink = (setupId: string, profileId: string) =>
  Effect.gen(function* () {
    return `${yield* WEB_HOST}/a/${yield* answerCode(setupId, profileId)}`
  })

/**
 * The other person's photo for an email, behind the same signature. Stored
 * photos sit behind links that expire in minutes; this one holds as long as
 * the setup is open to this person, and stops when it closes.
 */
export const answerPhotoUrl = (setupId: string, profileId: string) =>
  Effect.gen(function* () {
    const base = yield* API_BASE_URL
    const query = new URLSearchParams({
      setup: setupId,
      profile: profileId,
      sig: sign(yield* secret, setupId, profileId),
    })
    return `${base}/answer/photo?${query}`
  })
