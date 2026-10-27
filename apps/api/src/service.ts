import { EmbeddingModel } from '@effect/ai'
import { PgDrizzle } from '@swipeless/db'
import { effectiveStatus, isLiveSql } from '@swipeless/db/rules'
import { adminEvents, profiles, setups, waitlist } from '@swipeless/db/schema'
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
  type Setup,
  type SetupsResponse,
} from '@swipeless/shared'
import {
  and,
  arrayContains,
  cosineDistance,
  eq,
  inArray,
  isNotNull,
  ne,
  notInArray,
  or,
} from 'drizzle-orm'
import { Array as Arr, Clock, Effect, Option, Schedule } from 'effect'
import { AfterResponse } from './after-response.ts'
import { CurrentProfile } from './caller.ts'
import { FitWriter } from './fit-writer.ts'
import { SetupLifecycle } from './setups.ts'
import { Showcase, showcaseMatchId } from './showcase.ts'
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

/**
 * What the agent says once publish returns. SHOWCASE: nothing fits on day one,
 * so it does not look right away. PRODUCT.md, Voice: "go live your life,
 * we'll text you". Hosts without the skill only ever see this field.
 */
export const AFTER_PUBLISH =
  'Tell your human, in these words or close to them: "done, i published your profile. we\'ll text you when there\'s someone worth meeting. go live your life." Then stop. Do not look for candidates or dates now; swipeless texts them when someone fits. Write swipeless in lowercase, always.'

export class Swipeless extends Effect.Service<Swipeless>()('Swipeless', {
  dependencies: [SetupLifecycle.Default, Showcase.Default],
  effect: Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle
    const embeddings = yield* EmbeddingModel.EmbeddingModel
    const lifecycle = yield* SetupLifecycle
    const photos = yield* ProfilePhotos
    const afterResponse = yield* AfterResponse
    const fitWriter = yield* FitWriter
    /** One line per person and setup, kept while this instance lives. */
    const fits = new Map<string, string | undefined>()

    /**
     * Everything publish owes a new profile that the agent need not wait
     * for. Until the embedding lands the profile is not shown to anyone and
     * sees nobody; see `candidates`. Later post-publish work hooks in here.
     */
    const afterPublish = (profileId: string, brief: string) =>
      Effect.gen(function* () {
        const embedding = yield* embeddings.embed(brief)
        yield* db
          .update(profiles)
          .set({ embedding })
          .where(eq(profiles.id, profileId))
      }).pipe(
        Effect.retry(
          Schedule.exponential('200 millis').pipe(
            Schedule.compose(Schedule.recurs(3))
          )
        ),
        Effect.tap(() => Effect.logInfo('Embedded a published brief')),
        Effect.withLogSpan('embed'),
        Effect.orDie
      )
    const showcase = yield* Showcase

    return {
      /**
       * Open signup. Stores the photo and the profile, with only the hash of
       * its token, and records the publication for the admin site. The brief
       * is embedded after the response (`afterPublish`).
       */
      publish: (profile: Profile): Effect.Effect<PublishResponse> =>
        Effect.gen(function* () {
          const at = yield* now
          const token = yield* generateToken()

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
              firstName: profile.firstName,
              photoUrl: photoReference,
              phone: profile.privateLayer.phone,
              // Live the moment it is published, with no review first. This
              // knowingly departs from PRODUCT.md, Identity: "A person checks
              // every profile before it goes live." Back to 'pending' restores
              // the admin review queue.
              reviewStatus: 'approved',
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

          yield* afterResponse.run(afterPublish(row.id, profile.brief))
          // Showcase only: a staged date request for the presenter's phone.
          yield* showcase.published(row.id, profile.privateLayer.phone)
          yield* Effect.logInfo('Published a profile')

          return new PublishResponse({
            profileId: row.id,
            token,
            next: AFTER_PUBLISH,
          })
        }).pipe(Effect.withLogSpan('publish'), Effect.orDie),

      /**
       * The top briefs for a caller, best first.
       *
       * Hard filters: approved, embedded, unexpired profiles, not the caller, mutual
       * gender interest, same country, and nobody the caller already shares a
       * setup with. Ranking is cosine distance over brief embeddings.
       *
       * Only approved profiles are ever returned, and a caller that is not
       * approved is not live either, so it gets an empty page. Publish
       * approves at once; see `publish`.
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
          // empty page is the honest answer. So is a brief not embedded yet,
          // which publish finishes just after it answers.
          if (
            caller === undefined ||
            caller.reviewStatus !== 'approved' ||
            caller.embedding === null
          ) {
            return new CandidatesResponse({ candidates: [] })
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

          // Showcase only: the staged match is never anyone's candidate.
          const hidden = Option.toArray(yield* showcaseMatchId)
          excluded.push(...hidden)

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
                isNotNull(profiles.embedding),
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

      /**
       * Why the caller and the other person in this setup might click, for
       * the small page. Written once per instance and kept; given up after
       * a few seconds so the page never waits long for it.
       */
      whyYouFit: (
        setup: Setup
      ): Effect.Effect<string | undefined, never, CurrentProfile> =>
        Effect.gen(function* () {
          const current = yield* CurrentProfile
          const key = `${setup.setupId}:${current.profileId}`
          if (fits.has(key)) return fits.get(key)
          const [self] = yield* db
            .select({ firstName: profiles.firstName, brief: profiles.brief })
            .from(profiles)
            .where(eq(profiles.id, current.profileId))
          if (self === undefined) return undefined
          const fit = yield* fitWriter
            .whyYouFit({
              forFirstName: self.firstName,
              forBrief: self.brief,
              otherFirstName: setup.counterpart.firstName,
              otherBrief: setup.counterpart.brief,
            })
            .pipe(
              Effect.timeout('8 seconds'),
              Effect.orElseSucceed(() => undefined)
            )
          if (fit !== undefined) fits.set(key, fit)
          return fit
        }).pipe(Effect.orDie),

      /**
       * Every setup a short answer link can still open, with both people,
       * for the page to find a link's setup by its derived code. Only the
       * ones waiting on a yes or already a date: a handful at a time.
       */
      answerablePairs: (): Effect.Effect<
        ReadonlyArray<{
          readonly setupId: string
          readonly profileIds: readonly [string, string]
        }>
      > =>
        Effect.gen(function* () {
          const rows = yield* db
            .select({
              id: setups.id,
              a: setups.profileAId,
              b: setups.profileBId,
            })
            .from(setups)
            .where(inArray(setups.status, ['requested', 'confirmed']))
          return rows.map((row) => ({
            setupId: row.id,
            profileIds: [row.a, row.b] as const,
          }))
        }).pipe(Effect.orDie),

      /**
       * Someone on swipeless.me asks to hear when the closed beta opens.
       * Asking twice is fine and changes nothing.
       */
      joinWaitlist: (email: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* db
            .insert(waitlist)
            .values({ email: email.toLowerCase(), createdAt: yield* now })
            .onConflictDoNothing({ target: waitlist.email })
        }).pipe(Effect.orDie),
    }
  }),
}) {}
