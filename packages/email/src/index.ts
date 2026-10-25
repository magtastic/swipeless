import { Config, Context, Effect, Layer, Option, Redacted } from 'effect'

export * from './messages.ts'
export { escapeHtml, highlight, type Line, note } from './note.ts'

/** One email: a plain-text body, and the handwritten note when there is one. */
export interface Email {
  readonly to: string
  readonly subject: string
  readonly text: string
  readonly html?: string
}

/**
 * PRODUCT.md, SMS, email and small pages: "Everything after signup reaches
 * humans by SMS, email or agent reminders." This is the seam email leaves
 * through, shared by the API and the admin site.
 *
 * `send` cannot fail: an email that does not go out is never a reason to undo
 * a yes or an approval. Failures are logged, without the address or the body.
 */
export class Mailer extends Context.Tag('Mailer')<
  Mailer,
  {
    readonly send: (email: Email) => Effect.Effect<void>
  }
>() {}

/** Logs that an email would have gone out. Never the address or the body. */
export const MailerLog = Layer.succeed(
  Mailer,
  Mailer.of({
    send: (email) =>
      Effect.logInfo('email: not sent, no RESEND_API_KEY').pipe(
        Effect.annotateLogs({ subject: email.subject })
      ),
  })
)

const RESEND_URL = 'https://api.resend.com/emails'

const SEND_TIMEOUT = '10 seconds'

/**
 * Sends through Resend's REST API. `EMAIL_FROM` must be on a domain verified
 * in Resend; the default only delivers to the Resend account's own address,
 * which is enough to try it locally.
 */
const resend = (apiKey: Redacted.Redacted) =>
  Effect.gen(function* () {
    const from = yield* Config.string('EMAIL_FROM').pipe(
      Config.withDefault('swipeless <onboarding@resend.dev>')
    )
    const replyTo = yield* Config.option(Config.string('EMAIL_REPLY_TO'))
    return Mailer.of({
      send: (email) =>
        Effect.tryPromise(async (signal) => {
          const response = await fetch(RESEND_URL, {
            method: 'POST',
            signal,
            headers: {
              authorization: `Bearer ${Redacted.value(apiKey)}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              from,
              to: [email.to],
              subject: email.subject,
              text: email.text,
              ...(email.html ? { html: email.html } : {}),
              ...Option.match(replyTo, {
                onNone: () => ({}),
                onSome: (address) => ({ reply_to: address }),
              }),
            }),
          })
          if (!response.ok) {
            throw new Error(`Resend answered ${response.status}`)
          }
        }).pipe(
          // A stalled connection must not hold a yes open; the timeout
          // interrupts the fetch, which aborts it through the signal.
          Effect.timeout(SEND_TIMEOUT),
          Effect.catchAllCause((cause) =>
            Effect.logWarning('email: send failed', cause).pipe(
              Effect.annotateLogs({ subject: email.subject })
            )
          )
        ),
    })
  })

/**
 * Resend when `RESEND_API_KEY` is set, logging otherwise, so local
 * development and the test suites never need a key.
 */
export const MailerLive = Layer.unwrapEffect(
  Config.option(Config.redacted('RESEND_API_KEY')).pipe(
    Effect.map(
      Option.match({
        onNone: () => MailerLog,
        onSome: (apiKey) => Layer.effect(Mailer, resend(apiKey)),
      })
    )
  )
).pipe(Layer.orDie)
