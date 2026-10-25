import {
  CandidatesResponse,
  ConfirmResponse,
  Counterpart,
  DeclineResponse,
  InterestResponse,
  PublishResponse,
  Setup,
  SetupsResponse,
} from '@swipeless/shared'
import { Effect, Layer } from 'effect'
import { Swipeless } from '../../src/service.ts'
import { FAKE_PROFILE_ID, fakeCaller } from './fake-caller.ts'
import { FAKE_DATE } from './seams.ts'

export { FAKE_PROFILE_ID }

/**
 * A canned Swipeless for the transport tests.
 *
 * These tests are about the adapters: routing, schema validation, and the
 * mapping from a declared failure to an HTTP status or an MCP tool error. The
 * service itself is exercised against a real database in service.test.ts, so
 * here it is replaced wholesale and each test overrides only the method it
 * cares about.
 */

export const FAKE_SETUP_ID = '22222222-2222-4222-8222-222222222222'

/** A freshly picked setup, as the picking side sees it. */
export const FAKE_SETUP = new Setup({
  setupId: FAKE_SETUP_ID,
  counterpart: new Counterpart({
    profileId: '33333333-3333-4333-8333-333333333333',
    firstName: 'Jón',
    age: 36,
    photoUrl: 'https://example.invalid/jon.jpg',
    brief: 'He repairs cellos in a basement workshop and cycles everywhere.',
  }),
  status: 'suggested',
  date: FAKE_DATE,
  youPicked: true,
  youConfirmed: false,
  createdAt: '2026-09-10T12:00:00.000Z',
  updatedAt: '2026-09-10T12:00:00.000Z',
  expiresAt: '2026-09-24T12:00:00.000Z',
})

type FakeService = Omit<Swipeless, '_tag'>

const defaults: FakeService = {
  publish: () =>
    Effect.succeed(
      new PublishResponse({ profileId: FAKE_PROFILE_ID, token: 'fake-token' })
    ),
  candidates: () => Effect.succeed(new CandidatesResponse({ candidates: [] })),
  interest: () => Effect.succeed(new InterestResponse({ setup: FAKE_SETUP })),
  confirm: () => Effect.succeed(new ConfirmResponse({ status: 'confirmed' })),
  decline: () => Effect.succeed(new DeclineResponse({ status: 'declined' })),
  deleteProfile: () => Effect.void,
  setups: () => Effect.succeed(new SetupsResponse({ setups: [] })),
}

/**
 * An app layer of the same shape as AppLive — a service and a caller resolver
 * — with no database behind it.
 */
export const fakeApp = (
  overrides: Partial<FakeService> = {},
  caller = fakeCaller()
) =>
  Layer.mergeAll(
    Layer.succeed(Swipeless, Swipeless.make({ ...defaults, ...overrides })),
    caller
  )
