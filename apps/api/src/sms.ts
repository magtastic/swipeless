import { Config, Context, Effect, Layer, Option, Redacted } from 'effect'

/** One text message: an E.164 number and a plain body. */
export interface Text {
  readonly to: string
  readonly body: string
}

/**
 * PRODUCT.md, SMS, email and small pages: "Everything after signup reaches
 * humans by SMS, email or agent reminders." This is the seam texts leave
 * through.
 *
 * `send` cannot fail: a text that does not go out is never a reason to undo a
 * yes. Failures are logged without the number or the body.
 */
export class Sms extends Context.Tag('Sms')<
  Sms,
  {
    readonly send: (text: Text) => Effect.Effect<void>
  }
>() {}

/** Logs that a text would have gone out. Never the number or the body. */
export const SmsLog = Layer.succeed(
  Sms,
  Sms.of({
    send: () => Effect.logInfo('sms: not sent, no TWILIO_ACCOUNT_SID'),
  })
)

const SEND_TIMEOUT = '10 seconds'

/**
 * Sends through Twilio's Messages API. `SMS_FROM` is the sender: an
 * alphanumeric id like `swipeless` where the destination country allows one
 * (Iceland does), or a Twilio number. A Messaging Service sid (`MG…`) also
 * works there.
 */
const twilio = (accountSid: string, authToken: Redacted.Redacted) =>
  Effect.gen(function* () {
    const from = yield* Config.string('SMS_FROM').pipe(
      Config.withDefault('swipeless')
    )
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`
    const authorization = `Basic ${Buffer.from(`${accountSid}:${Redacted.value(authToken)}`).toString('base64')}`
    return Sms.of({
      send: (text) =>
        Effect.tryPromise(async (signal) => {
          const response = await fetch(url, {
            method: 'POST',
            signal,
            headers: {
              authorization,
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              To: text.to,
              Body: text.body,
              ...(from.startsWith('MG')
                ? { MessagingServiceSid: from }
                : { From: from }),
            }),
          })
          if (!response.ok) {
            // Twilio's message can quote the number; its code cannot.
            const { code } = (await response.json().catch(() => ({}))) as {
              code?: number
            }
            throw new Error(`Twilio answered ${response.status} (${code})`)
          }
        }).pipe(
          Effect.timeout(SEND_TIMEOUT),
          Effect.catchAllCause((cause) =>
            Effect.logWarning('sms: send failed', cause)
          )
        ),
    })
  })

/**
 * Twilio when `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are set, logging
 * otherwise, so local development and the test suites never need a key.
 */
export const SmsLive = Layer.unwrapEffect(
  Config.option(
    Config.all([
      Config.string('TWILIO_ACCOUNT_SID'),
      Config.redacted('TWILIO_AUTH_TOKEN'),
    ])
  ).pipe(
    Effect.map(
      Option.match({
        onNone: () => SmsLog,
        onSome: ([sid, token]) => Layer.effect(Sms, twilio(sid, token)),
      })
    )
  )
).pipe(Layer.orDie)
