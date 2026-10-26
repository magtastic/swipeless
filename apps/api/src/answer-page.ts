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
import {
  answerCode,
  type Choice,
  isAnswerCode,
  verifyAnswer,
} from './answer-links.ts'
import { CurrentProfile } from './caller.ts'
import { Swipeless } from './service.ts'

/**
 * The small yes-or-no page a date request links to. PRODUCT.md: "Nothing to
 * download, no login." The signed link stands in for the bearer token, for
 * this one setup only. Two addresses reach it: `/answer?setup=…&sig=…` from
 * the email, and the short `/a/<code>` a text carries, which swipeless.me
 * proxies here (docs/decisions.md, 2026-10-26).
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

const CodeParams = Schema.Struct({
  choice: Schema.optional(Schema.Literal('yes', 'no')),
})

/**
 * A link that held: whose it is, which setup, and what the page's buttons
 * post back to, so either address answers at the same address it showed.
 */
interface Link {
  readonly setup: string
  readonly profile: string
  readonly choice: Choice | undefined
  readonly action: string
  readonly hidden: Readonly<Record<string, string>>
}

const INK = '#2232A8'
const HI = '#F6EE5C'
const HI_INK = '#1E2342'

const page = (title: string, lines: ReadonlyArray<Line>, status = 200) =>
  HttpServerResponse.text(note(title, lines), {
    status,
    contentType: 'text/html; charset=utf-8',
    headers: {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
    },
  })

const closedLines: ReadonlyArray<Line> = [
  { hand: 'this date is no longer open.', size: 32 },
  { print: 'nothing to do here. go live your life, we will write.' },
  { blank: true },
  { hand: 'xo, swipeless' },
]
const closed = page('this date is no longer open', closedLines)
/** Same words for a link that never held, as a 404. */
const unknown = page('this date is no longer open', closedLines, 404)

type Service = typeof Swipeless.Service

/** The link stands in for the bearer token: act as its person. */
const asLinked = (link: Link) =>
  Effect.provideService(CurrentProfile, {
    profileId: link.profile as ProfileId,
  })

/** The email's signed link, if its signature holds. */
const signedLink = (params: typeof Params.Type) =>
  Effect.map(
    verifyAnswer(params.setup, params.profile, params.sig),
    (valid): Link | undefined =>
      valid
        ? {
            setup: params.setup,
            profile: params.profile,
            choice: params.choice,
            action: '/answer',
            hidden: {
              setup: params.setup,
              profile: params.profile,
              sig: params.sig,
            },
          }
        : undefined
  )

/** A text's short link: the open pair whose derived code this is. */
const codeLink = (
  swipeless: Service,
  code: string,
  choice: Choice | undefined
) =>
  Effect.gen(function* () {
    if (!isAnswerCode(code)) return undefined
    for (const pair of yield* swipeless.answerablePairs()) {
      for (const profile of pair.profileIds) {
        if ((yield* answerCode(pair.setupId, profile)) === code) {
          const link: Link = {
            setup: pair.setupId,
            profile,
            choice,
            action: `/a/${code}`,
            hidden: {},
          }
          return link
        }
      }
    }
    return undefined
  })

/** The caller's view of the setup, or undefined if they cannot see it. */
const load = (swipeless: Service, link: Link) =>
  Effect.gen(function* () {
    const { setups } = yield* swipeless.setups().pipe(asLinked(link))
    return setups.find(
      (setup) => setup.setupId.toLowerCase() === link.setup.toLowerCase()
    )
  })

const button = (link: Link, choice: Choice, picked: boolean) => {
  const filled = choice === 'yes'
  const hidden = Object.entries(link.hidden)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${name}" value="${escapeHtml(value)}">\n`
    )
    .join('')
  return `<form method="post" action="${escapeHtml(link.action)}" style="display:inline-block;margin:0 12px 0 0;">
${hidden}<input type="hidden" name="choice" value="${choice}">
<button type="submit" style="font:inherit;font-size:30px;cursor:pointer;padding:2px 18px;border-radius:6px;border:2px solid ${INK};background:${filled ? HI : 'transparent'};color:${filled ? HI_INK : INK};${picked ? `outline:3px solid ${INK};outline-offset:2px;` : ''}">${choice}</button>
</form>`
}

const ask = (link: Link, setup: Setup, fit: string | undefined) => {
  const { counterpart, date } = setup
  const name = escapeHtml(counterpart.firstName)
  return page(`${counterpart.firstName} would like to meet you`, [
    {
      hand: `<img src="${escapeHtml(counterpart.photoUrl)}" alt="${name}" width="180" style="display:block;max-width:100%;height:auto;border-radius:4px;margin:12px 0;">`,
    },
    { hand: `${name}, ${counterpart.age}`, size: 34 },
    { hand: 'would like to meet you.' },
    ...(fit
      ? ([{ blank: true }, { hand: escapeHtml(fit), size: 24 }] as const)
      : []),
    { blank: true },
    { hand: `where: ${escapeHtml(date.venue.name)}` },
    { hand: `when: ${highlight(escapeHtml(formatDateTime(date.time)))}` },
    { blank: true },
    { hand: 'do you want to go out?', size: 34 },
    {
      hand: `${button(link, 'yes', link.choice === 'yes')}${button(link, 'no', link.choice === 'no')}`,
    },
    {
      print:
        'no is always enough, and nobody is told why. if you both say yes, you get each other’s numbers.',
    },
  ])
}

const show = <E, R>(
  swipeless: Service,
  linked: Effect.Effect<Link | undefined, E, R>
) =>
  Effect.gen(function* () {
    const link = yield* linked
    if (link === undefined) return yield* unknown
    const setup = yield* load(swipeless, link)
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
    const fit = yield* swipeless.whyYouFit(setup).pipe(asLinked(link))
    return yield* ask(link, setup, fit)
  }).pipe(Effect.catchAll(() => closed))

const answer = <E, R>(
  swipeless: Service,
  linked: Effect.Effect<Link | undefined, E, R>
) =>
  Effect.gen(function* () {
    const link = yield* linked
    if (link === undefined) return yield* unknown
    const setup = yield* load(swipeless, link)
    if (setup === undefined || link.choice === undefined) return yield* closed
    const setupId = setup.setupId as SetupId
    const name = escapeHtml(setup.counterpart.firstName)

    if (link.choice === 'no') {
      yield* swipeless
        .decline(new DeclineRequest({ setupId }))
        .pipe(asLinked(link))
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
      .pipe(asLinked(link))
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
    const linked = yield* signedLink({ ...params, choice: undefined })
    const setup =
      linked === undefined ? undefined : yield* load(swipeless, linked)
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

const code = Effect.map(HttpLayerRouter.params, (params) => params.code ?? '')

/** GET shows the note, POST answers it, and the email's photo comes from here. */
export const AnswerRoutes = Layer.unwrapEffect(
  Effect.map(Swipeless, (swipeless) =>
    Layer.mergeAll(
      HttpLayerRouter.add(
        'GET',
        '/answer',
        show(
          swipeless,
          Effect.flatMap(
            HttpServerRequest.schemaSearchParams(Params),
            signedLink
          )
        )
      ),
      HttpLayerRouter.add(
        'POST',
        '/answer',
        answer(
          swipeless,
          Effect.flatMap(
            HttpServerRequest.schemaBodyUrlParams(Params),
            signedLink
          )
        )
      ),
      HttpLayerRouter.add(
        'GET',
        '/a/:code',
        show(
          swipeless,
          Effect.all([
            code,
            HttpServerRequest.schemaSearchParams(CodeParams),
          ]).pipe(
            Effect.flatMap(([code, { choice }]) =>
              codeLink(swipeless, code, choice)
            )
          )
        )
      ),
      HttpLayerRouter.add(
        'POST',
        '/a/:code',
        answer(
          swipeless,
          Effect.all([
            code,
            HttpServerRequest.schemaBodyUrlParams(CodeParams),
          ]).pipe(
            Effect.flatMap(([code, { choice }]) =>
              codeLink(swipeless, code, choice)
            )
          )
        )
      ),
      HttpLayerRouter.add('GET', '/answer/photo', photo(swipeless))
    )
  )
)
