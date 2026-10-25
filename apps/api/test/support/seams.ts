import { DateSuggestion, Venue } from '@swipeless/shared'
import { Effect, Layer } from 'effect'
import { DateSuggester } from '../../src/date-suggester.ts'
import { Notifier } from '../../src/notifier.ts'

/**
 * The two seams a setup reaches beyond the database. The date suggester is a
 * constant, so a test can assert on the date it stored; the notifier records
 * what it was asked to send, so a test can assert on who heard what.
 */

export const FAKE_DATE = new DateSuggestion({
  venue: new Venue({
    name: 'Kaffihús Vesturbæjar',
    address: 'Melhagi 20, 107 Reykjavík',
  }),
  time: '2099-09-17T19:30:00.000Z',
})

export const FixedDateSuggester = Layer.succeed(
  DateSuggester,
  DateSuggester.of({ suggest: () => Effect.succeed(FAKE_DATE) })
)

export type Notification = {
  readonly kind: 'dateRequested' | 'dateConfirmed'
  readonly profileId: string
  readonly setupId: string
}

/** Everything the recording notifier was asked to send, oldest first. */
export const notifications: Array<Notification> = []

export const RecordingNotifier = Layer.succeed(
  Notifier,
  Notifier.of({
    dateRequested: (profileId, setupId) =>
      Effect.sync(() => {
        notifications.push({ kind: 'dateRequested', profileId, setupId })
      }),
    dateConfirmed: (profileId, setupId) =>
      Effect.sync(() => {
        notifications.push({ kind: 'dateConfirmed', profileId, setupId })
      }),
  })
)

export const TestSeams = Layer.mergeAll(FixedDateSuggester, RecordingNotifier)
