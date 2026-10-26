import {
  HttpLayerRouter,
  HttpServerRequest,
  HttpServerResponse,
} from '@effect/platform'
import {
  escapeHtml,
  formatDateTime,
  highlight,
  type Line,
  note,
} from '@swipeless/email'
import { MAX_UPLOAD_BYTES, readCapped } from '@swipeless/photos'
import {
  ConfirmRequest,
  DeclineRequest,
  type ProfileId,
  type Setup,
  type SetupId,
} from '@swipeless/shared'
import { Config, Effect, Layer, Schema } from 'effect'
import { type Choice, verifyAnswer } from './answer-links.ts'
import { CurrentProfile } from './caller.ts'
import { Swipeless } from './service.ts'

/**
 * The small yes-or-no page a date request links to. PRODUCT.md: "Nothing to
 * download, no login." The signed link stands in for the bearer token, for
 * this one setup only.
 *
 * GET only shows the note: mail scanners open every link in an email, and a
 * scanner must never say yes for someone. The answer is the POST behind the
 * page's buttons, and it goes through the same `Swipeless.confirm` and
 * `decline` the agent tools call, so the rules and the emails are the same.
 */

const Params = Schema.Struct({
  setup: Schema.String,
  profile: Schema.String,
  sig: Schema.String,
  choice: Schema.optional(Schema.Literal('yes', 'no')),
})
type Params = typeof Params.Type

const INK = '#2232A8'
const HI = '#F6EE5C'
const HI_INK = '#1E2342'

const page = (title: string, lines: ReadonlyArray<Line>) =>
  HttpServerResponse.text(note(title, lines), {
    contentType: 'text/html; charset=utf-8',
    headers: {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
    },
  })

const closed = page('this date is no longer open', [
  { hand: 'this date is no longer open.', size: 32 },
  { print: 'nothing to do here. go live your life, we will write.' },
  { blank: true },
  { hand: 'xo, swipeless' },
])

type Service = typeof Swipeless.Service

/** The signed link stands in for the bearer token: act as its person. */
const asLinked = (params: Params) =>
  Effect.provideService(CurrentProfile, {
    profileId: params.profile as ProfileId,
  })

/** The caller's view of the setup, or undefined if the link does not hold. */
const load = (swipeless: Service, params: Params) =>
  Effect.gen(function* () {
    const valid = yield* verifyAnswer(params.setup, params.profile, params.sig)
    if (!valid) return undefined
    const { setups } = yield* swipeless.setups().pipe(asLinked(params))
    return setups.find(
      (setup) => setup.setupId.toLowerCase() === params.setup.toLowerCase()
    )
  })

const button = (params: Params, choice: Choice, picked: boolean) => {
  const filled = choice === 'yes'
  return `<form method="post" action="/answer" style="display:inline-block;margin:0 12px 0 0;">
<input type="hidden" name="setup" value="${escapeHtml(params.setup)}">
<input type="hidden" name="profile" value="${escapeHtml(params.profile)}">
<input type="hidden" name="sig" value="${escapeHtml(params.sig)}">
<input type="hidden" name="choice" value="${choice}">
<button type="submit" style="font:inherit;font-size:30px;cursor:pointer;padding:2px 18px;border-radius:6px;border:2px solid ${INK};background:${filled ? HI : 'transparent'};color:${filled ? HI_INK : INK};${picked ? `outline:3px solid ${INK};outline-offset:2px;` : ''}">${choice}</button>
</form>`
}

const ask = (params: Params, setup: Setup) => {
  const { counterpart, date } = setup
  const name = escapeHtml(counterpart.firstName)
  return page(`${counterpart.firstName} would like to meet you`, [
    {
      hand: `<img src="${escapeHtml(counterpart.photoUrl)}" alt="${name}" width="180" style="display:block;max-width:100%;height:auto;border-radius:4px;margin:12px 0;">`,
    },
    { hand: `${name}, ${counterpart.age}`, size: 34 },
    { hand: 'would like to meet you.' },
    { blank: true },
    { hand: `where: ${escapeHtml(date.venue.name)}` },
    { hand: `when: ${highlight(escapeHtml(formatDateTime(date.time)))}` },
    { blank: true },
    { hand: 'do you want to go out?', size: 34 },
    {
      hand: `${button(params, 'yes', params.choice === 'yes')}${button(params, 'no', params.choice === 'no')}`,
    },
    {
      print:
        'no is always enough, and nobody is told why. if you both say yes, you get each other’s numbers.',
    },
  ])
}

const show = (swipeless: Service) =>
  Effect.gen(function* () {
    const params = yield* HttpServerRequest.schemaSearchParams(Params)
    const setup = yield* load(swipeless, params)
    if (setup === undefined) return yield* closed
    if (setup.status === 'confirmed') {
      return yield* page("it's a date", [
        {
          hand: `it's a date with ${escapeHtml(setup.counterpart.firstName)}.`,
        },
        { print: 'we texted you both the details.' },
      ])
    }
    if (setup.status !== 'requested' || setup.youConfirmed) return yield* closed
    return yield* ask(params, setup)
  }).pipe(Effect.catchAll(() => closed))

const answer = (swipeless: Service) =>
  Effect.gen(function* () {
    const params = yield* HttpServerRequest.schemaBodyUrlParams(Params)
    const setup = yield* load(swipeless, params)
    if (setup === undefined || params.choice === undefined) return yield* closed
    const setupId = setup.setupId as SetupId
    const name = escapeHtml(setup.counterpart.firstName)

    if (params.choice === 'no') {
      yield* swipeless
        .decline(new DeclineRequest({ setupId }))
        .pipe(asLinked(params))
      return yield* page('ok, no', [
        { hand: 'ok. no it is.', size: 34 },
        { print: 'nobody is told why. we will keep looking.' },
        { hand: 'go live your life, we will write.' },
        { blank: true },
        { hand: 'xo, swipeless' },
      ])
    }

    const result = yield* swipeless
      .confirm(new ConfirmRequest({ setupId }))
      .pipe(asLinked(params))
    const phone = result.privateLayer?.phone
    return yield* page("it's a date", [
      { hand: "it's a date!", size: 38 },
      { hand: `you and ${name} both said ${highlight('yes')}.` },
      { blank: true },
      { hand: `where: ${escapeHtml(setup.date.venue.name)}` },
      {
        hand: `when: ${highlight(escapeHtml(formatDateTime(setup.date.time)))}`,
      },
      ...(phone
        ? [{ hand: `${name}'s number: ${highlight(escapeHtml(phone))}` }]
        : []),
      { print: 'we texted you both the details. text them, say hi.' },
      { blank: true },
      { hand: 'xo, swipeless' },
    ])
  }).pipe(Effect.catchAll(() => closed))

const PhotoParams = Schema.Struct({
  setup: Schema.String,
  profile: Schema.String,
  sig: Schema.String,
})

const noPhoto = HttpServerResponse.empty({ status: 404 })

/**
 * Only our own stored photos are proxied: the short-lived link the admin
 * app's photo route signs. An external https photo is linked from the email
 * as given, so this server never fetches an address a profile chose.
 */
const PHOTO_BASE_URL = Config.string('PHOTO_BASE_URL').pipe(
  Config.withDefault('https://admin.swipeless.me')
)

export const isOwnPhotoLink = (link: string, base: string) => {
  try {
    const url = new URL(link)
    return (
      url.origin === new URL(base).origin &&
      url.pathname.startsWith('/api/photos/')
    )
  } catch {
    return false
  }
}

/**
 * The other person's photo for the date request email. Same signature as the
 * page, and only while the setup is open to this person; then it is gone.
 * Proxied from the short-lived link the setup view carries, so the email
 * never holds a link to the stored photo itself.
 */
const photo = (swipeless: Service) =>
  Effect.gen(function* () {
    const params = yield* HttpServerRequest.schemaSearchParams(PhotoParams)
    const setup = yield* load(swipeless, params)
    if (
      setup === undefined ||
      (setup.status !== 'requested' && setup.status !== 'confirmed')
    ) {
      return yield* noPhoto
    }
    const link = setup.counterpart.photoUrl
    if (!isOwnPhotoLink(link, yield* PHOTO_BASE_URL)) return yield* noPhoto
    const response = yield* Effect.tryPromise(() =>
      fetch(link, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
    )
    const contentType = response.headers.get('content-type') ?? ''
    if (!response.ok || !/^image\/(jpeg|png|webp)$/.test(contentType)) {
      return yield* noPhoto
    }
    const bytes = yield* Effect.tryPromise(() =>
      readCapped(response, MAX_UPLOAD_BYTES)
    )
    if (bytes === undefined) return yield* noPhoto
    return HttpServerResponse.uint8Array(bytes, {
      contentType,
      headers: {
        'cache-control': 'private, max-age=3600',
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex',
      },
    })
  }).pipe(Effect.catchAll(() => noPhoto))

/** GET shows the note, POST answers it, and the email's photo comes from here. */
export const AnswerRoutes = Layer.unwrapEffect(
  Effect.map(Swipeless, (swipeless) =>
    Layer.mergeAll(
      HttpLayerRouter.add('GET', '/answer', show(swipeless)),
      HttpLayerRouter.add('POST', '/answer', answer(swipeless)),
      HttpLayerRouter.add('GET', '/answer/photo', photo(swipeless))
    )
  )
)
