import { Effect, Layer } from 'effect'
import { type Email, Mailer } from './index.ts'

/**
 * A mailer that keeps what it was asked to send, oldest first, so a test can
 * assert on who heard what. Clear `sent` between tests.
 */
export const recordingMailer = () => {
  const sent: Array<Email> = []
  const layer = Layer.succeed(
    Mailer,
    Mailer.of({
      send: (email) =>
        Effect.sync(() => {
          sent.push(email)
        }),
    })
  )
  return { sent, layer }
}
