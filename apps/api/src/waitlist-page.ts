import {
  HttpLayerRouter,
  HttpServerRequest,
  HttpServerResponse,
} from '@effect/platform'
import { highlight, type Line, note } from '@swipeless/email'
import { Effect, Layer, Schema } from 'effect'
import { Swipeless } from './service.ts'

/**
 * The waitlist form on swipeless.me, which proxies `/waitlist` here so the
 * form posts to its own origin. swipeless is in closed beta: this only keeps
 * the email so we can write when there's room. The form works without
 * script; with script the site shows its own thank-you and ignores the page.
 */

const Form = Schema.Struct({
  email: Schema.Trim.pipe(
    Schema.maxLength(254),
    Schema.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
  ),
})

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

const back =
  '<a href="https://swipeless.me/" style="color:inherit;">back to swipeless.me</a>'

const joined = page("you're on the list", [
  { hand: "you're on the list.", size: 32 },
  {
    hand: `we're in ${highlight('closed beta')} for now. when there's room, we'll email you.`,
  },
  { print: 'go live your life in the meantime.' },
  { blank: true },
  { hand: 'xo, swipeless' },
  { print: back },
])

const invalid = page(
  "that email didn't look right",
  [
    { hand: "that email didn't look right.", size: 32 },
    { print: `go back and try once more. ${back}` },
    { blank: true },
    { hand: 'xo, swipeless' },
  ],
  400
)

export const WaitlistRoutes = Layer.unwrapEffect(
  Effect.map(Swipeless, (swipeless) =>
    HttpLayerRouter.add(
      'POST',
      '/waitlist',
      HttpServerRequest.schemaBodyUrlParams(Form).pipe(
        Effect.flatMap(({ email }) => swipeless.joinWaitlist(email)),
        Effect.flatMap(() => joined),
        Effect.catchAll(() => invalid)
      )
    )
  )
)
