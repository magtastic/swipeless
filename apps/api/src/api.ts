import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSecurity,
} from '@effect/platform'
import {
  AuthError,
  CandidatesError,
  CandidatesQuery,
  CandidatesResponse,
  ConfirmError,
  ConfirmRequest,
  ConfirmResponse,
  DeclineError,
  DeclineRequest,
  DeclineResponse,
  DeleteError,
  HealthResponse,
  InterestError,
  InterestRequest,
  InterestResponse,
  Profile,
  PublishResponse,
  SetupsError,
  SetupsResponse,
} from '@swipeless/shared'
import { Schema } from 'effect'
import { CurrentProfile } from './caller.ts'

/**
 * The REST surface. Statuses are not declared here: every error in
 * `@swipeless/shared` carries its own status annotation, and each endpoint
 * declares the operation's failure union verbatim, so REST and MCP cannot
 * drift apart. 400 comes free from schema validation.
 */

/**
 * Bearer auth for every endpoint but health and publish. It declares the
 * scheme and the two ways it can fail; the resolution itself belongs to the
 * Caller module, which handlers.ts hands this middleware.
 */
export class BearerAuth extends HttpApiMiddleware.Tag<BearerAuth>()(
  'BearerAuth',
  {
    provides: CurrentProfile,
    failure: AuthError,
    security: { bearer: HttpApiSecurity.bearer },
  }
) {}

/** Unauthenticated. Used by uptime checks and the Vercel healthcheck. */
const health = HttpApiEndpoint.get('health', '/health').addSuccess(
  HealthResponse
)

/**
 * Open signup: publishing is how an agent gets its token in the first place,
 * so it takes no bearer and declares no failures (PublishError is `never`).
 */
const publish = HttpApiEndpoint.post('publish', '/publish')
  .setPayload(Profile)
  .addSuccess(PublishResponse)

const candidates = HttpApiEndpoint.get('candidates', '/candidates')
  .setUrlParams(CandidatesQuery)
  .addSuccess(CandidatesResponse)
  .addError(CandidatesError)
  .middleware(BearerAuth)

const interest = HttpApiEndpoint.post('interest', '/interest')
  .setPayload(InterestRequest)
  .addSuccess(InterestResponse)
  .addError(InterestError)
  .middleware(BearerAuth)

const confirm = HttpApiEndpoint.post('confirm', '/confirm')
  .setPayload(ConfirmRequest)
  .addSuccess(ConfirmResponse)
  .addError(ConfirmError)
  .middleware(BearerAuth)

const decline = HttpApiEndpoint.post('decline', '/decline')
  .setPayload(DeclineRequest)
  .addSuccess(DeclineResponse)
  .addError(DeclineError)
  .middleware(BearerAuth)

const deleteProfile = HttpApiEndpoint.del('deleteProfile', '/profile')
  .addSuccess(Schema.Void, { status: 204 })
  .addError(DeleteError)
  .middleware(BearerAuth)

const setups = HttpApiEndpoint.get('setups', '/setups')
  .addSuccess(SetupsResponse)
  .addError(SetupsError)
  .middleware(BearerAuth)

export const SwipelessGroup = HttpApiGroup.make('swipeless')
  .add(health)
  .add(publish)
  .add(candidates)
  .add(interest)
  .add(confirm)
  .add(decline)
  .add(deleteProfile)
  .add(setups)

export const SwipelessApi = HttpApi.make('swipeless').add(SwipelessGroup)
