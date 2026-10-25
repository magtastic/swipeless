import { EmbeddingModel } from '@effect/ai'
import { PgDrizzle } from '@swipeless/db'
import { effectiveStatus, isLiveSql } from '@swipeless/db/rules'
import { adminEvents, profiles, setups } from '@swipeless/db/schema'
import { ProfilePhotos } from '@swipeless/photos'
import {
  Candidate,
  CandidateCore,
  CandidatesResponse,
  type CandidatesResponse as CandidatesResponseType,
  type ConfirmRequest,
  type ConfirmResponse,
  type Conflict,
  type DeclineRequest,
  type DeclineResponse,
  type InterestRequest,
  type InterestResponse,
  type NotFound,
  type Profile,
  PublishResponse,
  type RateLimited,
  type SetupsResponse,
} from '@swipeless/shared'
import {
  and,
  arrayContains,
  cosineDistance,
  eq,
  inArray,
  ne,
  notInArray,
  or,
} from 'drizzle-orm'
import { Array as Arr, Clock, Effect } from 'effect'
import { CurrentProfile } from './caller.ts'
import { SetupLifecycle } from './setups.ts'
import { generateToken, hashToken } from './token.ts'

/**
 * The service. The HttpApi handlers and the MCP tools both call these methods
 * and nothing else, so the two interfaces cannot drift.
 *
 * Failures are the operation's failures only. Every method but `publish`
 * reads who is calling from `CurrentProfile`, which the transport resolves
 * before any of this is reached, so `Unauthorized` and `Gone` are not here.
 *
 * Every timestamp comes from `Clock` at call time, never from `now()` in SQL,
 * so a test can move time with `TestClock`.
 *
 * The application layer supplies database, embedding, photo, date-suggestion
 * and notification services. SetupLifecycle supplies the state machine. Tests use a real database and
 * replace external object storage and embeddings at their network boundaries.
 */
const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis))

export class Swipeless extends Effect.Service<Swipeless>()('Swipeless', {
  dependencies: [SetupLifecycle.Default],
  effect: Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle
    const embeddings = yield* EmbeddingModel.EmbeddingModel
    const lifecycle = yield* SetupLifecycle
    const photos = yield* ProfilePhotos

    return {
      /**
       * Open signup. Embeds the brief, stores the profile with only the hash
       * of its token, and records the publication for the admin site.
       */
      publish: (profile: Profile): Effect.Effect<PublishResponse> =>
        Effect.gen(function* () {
          const at = yield* now
          const token = yield* generateToken()
          const embedding = yield* embeddings.embed(profile.brief)

          const photoReference = yield* photos.store(profile.photoUrl)
          const inserted = yield* db
            .insert(profiles)
            .values({
              tokenHash: hashToken(token),
              age: profile.age,
              gender: profile.gender,
              interestedIn: [...profile.interestedIn],
              city: profile.city,
              country: profile.country,
              radiusKm: profile.radiusKm,
              availability: profile.availability,
              brief: profile.brief,
              embedding,
              firstName: profile.firstName,
              photoUrl: photoReference,
              phone: profile.privateLayer.phone,
              // PRODUCT.md, Identity: "A person checks every profile before
              // it goes live." Nobody is matched until that person approves.
              reviewStatus: 'pending',
              email: profile.email ?? null,
              standingInstructions: profile.standingInstructions ?? null,
              createdAt: at,
              lastSeenAt: at,
            })
            .returning({ id: profiles.id })
            .pipe(Effect.onError(() => photos.discard(photoReference)))

          const row = inserted[0]
          if (row === undefined) {
            return yield* Effect.dieMessage('publish inserted no profile')
          }

          // Nothing personal: the admin site counts signups, it does not read
          // them. PRODUCT.md: the admin site sees counts, never briefs.
          yield* db.insert(adminEvents).values({
            kind: 'profile.published',
            profileId: row.id,
            payload: { country: profile.country, gender: profile.gender },
            createdAt: at,
          })

          return new PublishResponse({ profileId: row.id, token })
        }).pipe(Effect.orDie),

      /**
       * The top briefs for a caller, best first.
       *
       * Hard filters: approved, unexpired profiles, not the caller, mutual
       * gender interest, same country, and nobody the caller already shares a
       * setup with. Ranking is cosine distance over brief embeddings.
       *
       * PRODUCT.md, Identity: "A person checks every profile before it goes
       * live." Only approved profiles are ever returned, and a caller still
       * waiting on that check is not live either, so it gets an empty page.
       *
       * PRODUCT.md also lists age and distance among the hard filters. Neither
       * can be applied: the core carries an age but no age preference, and a
       * city and a radius but no coordinates. Flagged rather than invented.
       */
      candidates: (
        limit: number
      ): Effect.Effect<CandidatesResponseType, never, CurrentProfile> =>
        Effect.gen(function* () {
          const current = yield* CurrentProfile
          const at = yield* now

          const callers = yield* db
            .select({
              gender: profiles.gender,
              interestedIn: profiles.interestedIn,
              country: profiles.country,
              embedding: profiles.embedding,
              reviewStatus: profiles.reviewStatus,
            })
            .from(profiles)
            .where(eq(profiles.id, current.profileId))
            .limit(1)

          const caller = callers[0]
          // The caller's row is gone. Phase 2A's Caller module answers this
          // with Unauthorized before the service is reached; until then an
          // empty page is the honest answer.
          if (caller === undefined || caller.reviewStatus !== 'approved') {
            return new CandidatesResponse({ candidates: [] })
          }
          if (caller.embedding === null) {
            return yield* Effect.dieMessage(
              'profile has no embedding; publish always writes one'
            )
          }
          if (!Arr.isNonEmptyReadonlyArray(caller.interestedIn)) {
            return yield* Effect.dieMessage(
              'profile has an empty interestedIn; the contract forbids it'
            )
          }

          // A pick is symmetric for filtering purposes even though it is
          // invisible: anyone already paired with the caller is off the list,
          // and a declined pair stays off for good. PRODUCT.md: only a no
          // closes a pair, so an expired setup puts the two back in play.
          const paired = yield* db
            .select({
              a: setups.profileAId,
              b: setups.profileBId,
              status: setups.status,
              expiresAt: setups.expiresAt,
              date: setups.date,
            })
            .from(setups)
            .where(
              or(
                eq(setups.profileAId, current.profileId),
                eq(setups.profileBId, current.profileId)
              )
            )

          const excluded = paired
            .filter((pair) => effectiveStatus(pair, at.getTime()) !== 'expired')
            .map((pair) => (pair.a === current.profileId ? pair.b : pair.a))

          const distance = cosineDistance(profiles.embedding, caller.embedding)

          const rows = yield* db
            .select({
              id: profiles.id,
              age: profiles.age,
              gender: profiles.gender,
              interestedIn: profiles.interestedIn,
              city: profiles.city,
              country: profiles.country,
              availability: profiles.availability,
              brief: profiles.brief,
              distance,
            })
            .from(profiles)
            .where(
              and(
                eq(profiles.reviewStatus, 'approved'),
                isLiveSql(at.getTime()),
                ne(profiles.id, current.profileId),
                eq(profiles.country, caller.country),
                inArray(profiles.gender, [...caller.interestedIn]),
                arrayContains(profiles.interestedIn, [caller.gender]),
                ...(excluded.length === 0
                  ? []
                  : [notInArray(profiles.id, excluded)])
              )
            )
            .orderBy(distance)
            .limit(limit)

          const candidates: Array<Candidate> = []
          for (const row of rows) {
            if (!Arr.isNonEmptyReadonlyArray(row.interestedIn)) {
              return yield* Effect.dieMessage(
                'profile has an empty interestedIn; the contract forbids it'
              )
            }
            candidates.push(
              new Candidate({
                profileId: row.id,
                core: new CandidateCore({
                  age: row.age,
                  gender: row.gender,
                  interestedIn: row.interestedIn,
                  city: row.city,
                  country: row.country,
                  availability: row.availability,
                }),
                brief: row.brief,
                score: Math.max(0, Math.min(1, 1 - Number(row.distance))),
              })
            )
          }

          return new CandidatesResponse({ candidates })
        }).pipe(Effect.orDie),

      /**
       * A hard delete. The cascade takes the setups with it; the admin event
       * outlives the profile, which is why admin_events has no foreign key.
       */
      deleteProfile: (): Effect.Effect<void, never, CurrentProfile> =>
        Effect.gen(function* () {
          const current = yield* CurrentProfile
          const at = yield* now

          const rows = yield* db
            .select({ photoUrl: profiles.photoUrl })
            .from(profiles)
            .where(eq(profiles.id, current.profileId))
          const photo = rows[0]?.photoUrl
          if (photo) yield* photos.discard(photo)
          yield* db.delete(profiles).where(eq(profiles.id, current.profileId))

          yield* db.insert(adminEvents).values({
            kind: 'profile.deleted',
            profileId: current.profileId,
            payload: {},
            createdAt: at,
          })
        }).pipe(Effect.orDie),

      /* --- The setup lifecycle. Every rule lives in SetupLifecycle;  --- */
      /* --- this reads the caller, unwraps the request, and no more. --- */

      interest: (
        request: InterestRequest
      ): Effect.Effect<
        InterestResponse,
        NotFound | RateLimited,
        CurrentProfile
      > =>
        Effect.flatMap(CurrentProfile, (current) =>
          lifecycle.expressInterest(current, request.profileId)
        ),

      confirm: (
        request: ConfirmRequest
      ): Effect.Effect<ConfirmResponse, NotFound | Conflict, CurrentProfile> =>
        Effect.flatMap(CurrentProfile, (current) =>
          lifecycle.confirm(current, request.setupId)
        ),

      decline: (
        request: DeclineRequest
      ): Effect.Effect<DeclineResponse, NotFound | Conflict, CurrentProfile> =>
        Effect.flatMap(CurrentProfile, (current) =>
          lifecycle.decline(current, request.setupId)
        ),

      setups: (): Effect.Effect<SetupsResponse, never, CurrentProfile> =>
        Effect.flatMap(CurrentProfile, (current) => lifecycle.listFor(current)),
    }
  }),
}) {}
