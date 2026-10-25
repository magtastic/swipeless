import { PgDrizzle } from '@swipeless/db'
import {
  PROFILE_TTL_DAYS,
  profiles,
  type SetupRow,
  setups,
} from '@swipeless/db/schema'
import { PhotoLinks } from '@swipeless/photos'
import {
  ConfirmResponse,
  Conflict,
  Counterpart,
  DateSuggestion,
  DeclineResponse,
  InterestResponse,
  NotFound,
  PrivateLayer,
  type ProfileId,
  RateLimited,
  Setup,
  type SetupId,
  type SetupStatus,
  SetupsResponse,
} from '@swipeless/shared'
import { and, desc, eq, gt, inArray, isNull, not, or, sql } from 'drizzle-orm'
import { Clock, Config, Effect, Schema } from 'effect'
import { type DateParty, DateSuggester } from './date-suggester.ts'
import { Notifier } from './notifier.ts'
import type { AuthenticatedProfile } from './service.ts'

/**
 * The setup: one row per pair, from an agent's pick to the release of the
 * phone numbers.
 *
 * PRODUCT.md, The setup and the date, is the whole state machine:
 *
 *   pick ──▶ suggested ──yes──▶ requested ──yes──▶ confirmed
 *               │                   │
 *               └──── no ───────────┴──▶ declined        (final, both sides)
 *               └──── 14 days, no transition ──▶ expired  (lazy, see below)
 *               └──── the suggested time passes ──▶ expired
 *
 * - An agent's pick creates the setup with a date the `DateSuggester` makes
 *   for both people. `suggested` is visible only to the side that picked:
 *   "The picking human sees the note first, through their agent."
 * - The first human's yes makes it `requested`: "If they say yes, the other
 *   person gets a date request by SMS." From here both sides can see it, and
 *   the `Notifier` tells the other one.
 * - The second yes makes it `confirmed` and releases each side's phone number
 *   to the other: "When both say yes, both get the other's phone number."
 * - Either side may say no at any point before both said yes. "No is final",
 *   and "A no closes the pair for good": the row stays, which is what keeps
 *   the pair out of each other's candidates and makes a second pick NotFound.
 * - Only a no closes a pair. An expired setup leaves the two free to meet
 *   again: they come back as candidates, and a fresh pick replaces the
 *   expired row with a new setup and a new date.
 *
 * Everything that makes a setup a setup lives in here — the ordered pair, who
 * may see a row, the weekly ceiling on picks, lazy expiry, and the guarded
 * write that keeps two concurrent calls from stepping on each other. The
 * adapters and `Swipeless` know none of it; they call the five methods below.
 *
 * `AuthenticatedProfile` is imported as a type only. `service.ts` imports this
 * module for real, so a value import would close a module cycle and leave
 * `SetupLifecycle` undefined for whichever file is loaded first.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * PRODUCT.md: "A setup with no transition for fourteen days expires."
 * Refreshed on every transition.
 *
 * Exported for this module's tests.
 */
export const SETUP_TTL_MS = 14 * DAY_MS

/**
 * The window the weekly ceiling on picks counts over.
 *
 * Exported for this module's tests.
 */
export const INTEREST_WINDOW_MS = 7 * DAY_MS

/**
 * PRODUCT.md: "Profiles expire automatically after ninety days without a
 * check-in." Derived from the schema constant rather than imported from
 * `service.ts`, for the module-cycle reason above; the two are the same
 * ninety days.
 */
const PROFILE_TTL_MS = PROFILE_TTL_DAYS * DAY_MS

/** One side of the ordered pair. Internal: the contract speaks of "you". */
type Side = 'a' | 'b'

/**
 * Statuses that no longer age out. PRODUCT.md: "A confirmed setup does not
 * expire", and a declined or expired one has nothing left to wait for.
 */
const SETTLED: ReadonlySet<SetupStatus> = new Set<SetupStatus>([
  'confirmed',
  'declined',
  'expired',
])

/**
 * Still waiting on a human. A pick can join one of these, and either side may
 * say no to one: "Either human may say no at any point before both have said
 * yes."
 */
const OPEN = [
  'suggested',
  'requested',
] as const satisfies ReadonlyArray<SetupStatus>
const isOpen = (status: SetupStatus): boolean =>
  (OPEN as ReadonlyArray<SetupStatus>).includes(status)

/**
 * The status the outside world sees. Expiry is lazy: no job walks the table,
 * so a row reads as `expired` from the moment it has gone fourteen days
 * without a transition, or the suggested time has come and gone without
 * both yeses — a date in the past is not a date anyone can still say yes
 * to. Every operation answers from this, never from the stored column.
 *
 * Exported for `Swipeless.candidates`, which lets expired pairs meet again.
 */
export const effectiveStatus = (
  row: Pick<SetupRow, 'status' | 'expiresAt' | 'date'>,
  at: number
): SetupStatus =>
  SETTLED.has(row.status)
    ? row.status
    : row.expiresAt.getTime() <= at || Date.parse(row.date.time) <= at
      ? 'expired'
      : row.status

/**
 * The same rule in SQL, for guarded writes: the row has neither aged out nor
 * passed its suggested time. Stored date times are ISO-8601 instants.
 */
const liveAt = (at: number) =>
  sql`(${setups.expiresAt} > ${new Date(at)} and (${setups.date}->>'time')::timestamptz > ${new Date(at)})`

/** The caller's side of the ordered pair, or null if they are not in it. */
const sideIn = (row: SetupRow, profileId: ProfileId): Side | null =>
  row.profileAId === profileId ? 'a' : row.profileBId === profileId ? 'b' : null

const other = (side: Side): Side => (side === 'a' ? 'b' : 'a')

const pickedBy = (row: SetupRow, side: Side): boolean =>
  (side === 'a' ? row.interestedAAt : row.interestedBAt) !== null

const confirmedBy = (row: SetupRow, side: Side): boolean =>
  side === 'a' ? row.confirmedA : row.confirmedB

const profileOf = (row: SetupRow, side: Side): ProfileId =>
  side === 'a' ? row.profileAId : row.profileBId

const counterpartIdOf = (row: SetupRow, side: Side): ProfileId =>
  profileOf(row, other(side))

/**
 * PRODUCT.md: "Interest stays hidden until both say yes, so nobody ever sees
 * a no." A side sees a setup once its own agent picked, or once a human said
 * yes, which is what turned it into a date request. A row that was declined
 * or expired stays visible to exactly the sides that could see it before. On
 * a `suggested` row that is the side or sides whose agent picked: a no there
 * reaches the other side only if its agent had picked too, and then it learns
 * only that the date is not happening.
 */
const visibleTo = (row: SetupRow, side: Side): boolean =>
  pickedBy(row, side) || row.confirmedA || row.confirmedB

/**
 * The ordered pair for two profiles. The unique key and the check constraint
 * both demand `profileAId < profileBId`, and lowercasing first keeps a
 * differently-cased id from ordering the pair the wrong way round.
 */
const pairOf = (
  callerId: ProfileId,
  targetId: ProfileId
): {
  readonly aId: ProfileId
  readonly bId: ProfileId
  readonly side: Side
} => {
  const caller = callerId.toLowerCase()
  const target = targetId.toLowerCase()
  return caller < target
    ? { aId: caller, bId: target, side: 'a' }
    : { aId: target, bId: caller, side: 'b' }
}

const decodeDate = Schema.decodeUnknown(DateSuggestion)
const encodeDate = Schema.encodeSync(DateSuggestion)

/**
 * A database failure is not something an agent can act on, so it is a defect
 * rather than a declared error. Wrapping each query keeps the domain errors
 * alone in the method signatures.
 */
const query = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, never, R> => Effect.orDie(effect)

/** What the note and the private layer need from a counterpart's profile. */
type Person = {
  readonly id: ProfileId
  readonly firstName: string
  readonly age: number
  readonly photoUrl: string | null
  readonly phone: string
  readonly brief: string
}

export class SetupLifecycle extends Effect.Service<SetupLifecycle>()(
  'SetupLifecycle',
  {
    dependencies: [],
    effect: Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle
      const photoLinks = yield* PhotoLinks
      const suggester = yield* DateSuggester
      const notifier = yield* Notifier

      /**
       * PRODUCT.md: "The service enforces a separate ceiling, twenty per
       * week, whatever the skill says." Read once: a misconfigured ceiling is
       * a deploy problem, not a per-call one.
       */
      const weeklyCap = yield* Config.integer('INTEREST_WEEKLY_CAP').pipe(
        Config.withDefault(20),
        Effect.orDie
      )

      const rowById = (setupId: SetupId) =>
        query(
          db.select().from(setups).where(eq(setups.id, setupId)).limit(1)
        ).pipe(Effect.map((rows) => rows[0]))

      const rowByPair = (aId: ProfileId, bId: ProfileId) =>
        query(
          db
            .select()
            .from(setups)
            .where(and(eq(setups.profileAId, aId), eq(setups.profileBId, bId)))
            .limit(1)
        ).pipe(Effect.map((rows) => rows[0]))

      /**
       * The row as this caller may see it. A setup they are not part of, and
       * one they cannot see yet, are both simply absent: the other side must
       * not be able to tell the two apart.
       */
      const visibleRow = (
        caller: AuthenticatedProfile,
        setupId: SetupId
      ): Effect.Effect<
        { readonly row: SetupRow; readonly side: Side },
        NotFound
      > =>
        Effect.gen(function* () {
          const row = yield* rowById(setupId)
          if (row === undefined) return yield* new NotFound()
          const side = sideIn(row, caller.profileId)
          if (side === null || !visibleTo(row, side)) {
            return yield* new NotFound()
          }
          return { row, side }
        })

      /**
       * A guarded write touched nothing twice, so somebody else keeps moving
       * the row. Re-read and answer with what is true now rather than with
       * what was true when this call started.
       */
      const staleConflict = (
        caller: AuthenticatedProfile,
        setupId: SetupId
      ): Effect.Effect<never, NotFound | Conflict> =>
        Effect.gen(function* () {
          const { row } = yield* visibleRow(caller, setupId)
          const at = yield* Clock.currentTimeMillis
          return yield* new Conflict({ status: effectiveStatus(row, at) })
        })

      /**
       * The ceiling counts the picks this caller made inside the window,
       * whichever side of the pair they are on. `retryAfterSeconds` is the
       * wait until the oldest of them falls out of it.
       */
      const enforceCap = (
        callerId: ProfileId,
        at: number
      ): Effect.Effect<void, RateLimited> =>
        Effect.gen(function* () {
          const since = new Date(at - INTEREST_WINDOW_MS)

          const rows = yield* query(
            db
              .select({
                profileAId: setups.profileAId,
                interestedAAt: setups.interestedAAt,
                interestedBAt: setups.interestedBAt,
              })
              .from(setups)
              .where(
                or(
                  and(
                    eq(setups.profileAId, callerId),
                    gt(setups.interestedAAt, since)
                  ),
                  and(
                    eq(setups.profileBId, callerId),
                    gt(setups.interestedBAt, since)
                  )
                )
              )
          )

          const picked = rows
            .map((row) =>
              row.profileAId === callerId
                ? row.interestedAAt
                : row.interestedBAt
            )
            .filter((when): when is Date => when !== null)
            .map((when) => when.getTime())

          if (picked.length < weeklyCap) return

          const oldest = Math.min(...picked)
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil((oldest + INTEREST_WINDOW_MS - at) / 1000)
          )
          return yield* new RateLimited({ retryAfterSeconds })
        })

      /** The people behind a set of counterpart ids, by id. */
      const peopleById = (ids: ReadonlyArray<ProfileId>) =>
        Effect.gen(function* () {
          const people = new Map<ProfileId, Person>()
          if (ids.length === 0) return people
          const rows = yield* query(
            db
              .select({
                id: profiles.id,
                firstName: profiles.firstName,
                age: profiles.age,
                photoUrl: profiles.photoUrl,
                phone: profiles.phone,
                brief: profiles.brief,
              })
              .from(profiles)
              .where(inArray(profiles.id, [...new Set(ids)]))
          )
          for (const row of rows) people.set(row.id, row)
          return people
        })

      /**
       * PRODUCT.md, Vocabulary: the note shows "first name, photo, age". The
       * photo link is signed and short-lived; a profile from before photos
       * were required has none, and the note says so with an empty string.
       */
      const counterpartNote = (person: Person) =>
        Effect.gen(function* () {
          return new Counterpart({
            profileId: person.id,
            firstName: person.firstName,
            age: person.age,
            brief: person.brief,
            photoUrl:
              person.photoUrl === null
                ? ''
                : yield* photoLinks.url(person.photoUrl, person.id),
          })
        })

      /**
       * The caller's view of one row. `youConfirmed` is the caller's flag
       * only: PRODUCT.md does not let either side watch the other decide.
       * The phone number travels only on a confirmed setup.
       */
      const toSetup = (
        row: SetupRow,
        side: Side,
        at: number,
        people: ReadonlyMap<ProfileId, Person>
      ) =>
        Effect.gen(function* () {
          const person = people.get(counterpartIdOf(row, side))
          if (person === undefined) {
            // The cascade takes setups with the profile, so a setup whose
            // counterpart is gone cannot exist.
            return yield* Effect.dieMessage('setup has no counterpart profile')
          }
          const status = effectiveStatus(row, at)
          const date = yield* decodeDate(row.date).pipe(Effect.orDie)

          return new Setup({
            setupId: row.id,
            counterpart: yield* counterpartNote(person),
            status,
            date,
            youPicked: pickedBy(row, side),
            youConfirmed: confirmedBy(row, side),
            ...(status === 'confirmed'
              ? {
                  counterpartPrivateLayer: new PrivateLayer({
                    phone: person.phone,
                  }),
                }
              : {}),
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
            expiresAt: row.expiresAt.toISOString(),
          })
        })

      const viewOf = (row: SetupRow, side: Side, at: number) =>
        Effect.flatMap(peopleById([counterpartIdOf(row, side)]), (people) =>
          toSetup(row, side, at, people)
        )

      /**
       * The pick lands on a pair whose row is not expired. Repeating a pick is
       * free; picking someone whose agent already picked you joins their
       * setup, spends a pick, restarts its fourteen days, and leaves both
       * humans still owing a yes. A declined pair stays closed.
       */
      const joinExisting = (
        caller: AuthenticatedProfile,
        row: SetupRow,
        side: Side,
        at: number,
        retried = false
      ): Effect.Effect<InterestResponse, NotFound | RateLimited> =>
        Effect.gen(function* () {
          const status = effectiveStatus(row, at)

          // "A no closes the pair for good: they are never shown to each
          // other again." An expired row is replaced before it gets here;
          // one that expired mid-call is not joined either.
          if (status === 'declined' || status === 'expired') {
            return yield* new NotFound()
          }

          if (pickedBy(row, side) || !isOpen(status)) {
            if (!visibleTo(row, side)) return yield* new NotFound()
            return new InterestResponse({ setup: yield* viewOf(row, side, at) })
          }

          yield* enforceCap(caller.profileId, at)

          const updated = yield* query(
            db
              .update(setups)
              .set({
                ...(side === 'a'
                  ? { interestedAAt: new Date(at) }
                  : { interestedBAt: new Date(at) }),
                updatedAt: new Date(at),
                expiresAt: new Date(at + SETUP_TTL_MS),
              })
              .where(
                and(
                  eq(setups.id, row.id),
                  inArray(setups.status, [...OPEN]),
                  liveAt(at),
                  side === 'a'
                    ? isNull(setups.interestedAAt)
                    : isNull(setups.interestedBAt)
                )
              )
              .returning()
          )

          const written = updated[0]
          if (written !== undefined) {
            return new InterestResponse({
              setup: yield* viewOf(written, side, at),
            })
          }

          // Someone moved the row underneath us. Interest declares no
          // Conflict, so answer from where the setup stands now.
          const fresh = yield* rowById(row.id)
          if (fresh === undefined || retried) return yield* new NotFound()
          return yield* joinExisting(caller, fresh, side, at, true)
        })

      /**
       * One human's yes. Returns undefined when the guarded write lost a race,
       * so `confirm` can look again.
       */
      const confirmOnce = (
        caller: AuthenticatedProfile,
        setupId: SetupId
      ): Effect.Effect<ConfirmResponse | undefined, NotFound | Conflict> =>
        Effect.gen(function* () {
          const { row, side } = yield* visibleRow(caller, setupId)
          const at = yield* Clock.currentTimeMillis
          const status = effectiveStatus(row, at)
          const counterpartId = counterpartIdOf(row, side)

          // "When both say yes, both get the other's phone number."
          const released = () =>
            Effect.gen(function* () {
              const people = yield* peopleById([counterpartId])
              const person = people.get(counterpartId)
              if (person === undefined) {
                return yield* Effect.dieMessage(
                  'confirmed setup has no counterpart profile'
                )
              }
              return new ConfirmResponse({
                status: 'confirmed',
                privateLayer: new PrivateLayer({ phone: person.phone }),
              })
            })

          // Saying yes twice is the same yes.
          if (status === 'confirmed') return yield* released()
          if (!isOpen(status)) return yield* new Conflict({ status })
          if (confirmedBy(row, side)) return new ConfirmResponse({ status })

          const otherSaidYes = confirmedBy(row, other(side))
          const mine =
            side === 'a' ? { confirmedA: true } : { confirmedB: true }
          const theirs =
            side === 'a'
              ? eq(setups.confirmedB, otherSaidYes)
              : eq(setups.confirmedA, otherSaidYes)

          const updated = yield* query(
            db
              .update(setups)
              .set({
                ...mine,
                status: otherSaidYes ? 'confirmed' : 'requested',
                updatedAt: new Date(at),
                expiresAt: new Date(at + SETUP_TTL_MS),
              })
              .where(
                and(
                  eq(setups.id, row.id),
                  eq(setups.status, status),
                  liveAt(at),
                  theirs
                )
              )
              .returning({ id: setups.id })
          )
          if (updated.length === 0) return undefined

          if (otherSaidYes) {
            yield* notifier.dateConfirmed(profileOf(row, side), row.id)
            yield* notifier.dateConfirmed(counterpartId, row.id)
            return yield* released()
          }

          yield* notifier.dateRequested(counterpartId, row.id)
          return new ConfirmResponse({ status: 'requested' })
        })

      return {
        /**
         * The agent's pick. Creates the setup with a date made for both, or
         * joins the one the other side's agent already started. Answers with
         * the caller's view of the setup, so the agent can show the note.
         */
        expressInterest: (
          caller: AuthenticatedProfile,
          targetProfileId: ProfileId
        ): Effect.Effect<InterestResponse, NotFound | RateLimited> =>
          Effect.gen(function* () {
            if (
              targetProfileId.toLowerCase() === caller.profileId.toLowerCase()
            ) {
              return yield* new NotFound()
            }

            const at = yield* Clock.currentTimeMillis
            const activeSince = new Date(at - PROFILE_TTL_MS)

            const found = yield* query(
              db
                .select({
                  id: profiles.id,
                  reviewStatus: profiles.reviewStatus,
                  lastSeenAt: profiles.lastSeenAt,
                  city: profiles.city,
                  country: profiles.country,
                  availability: profiles.availability,
                })
                .from(profiles)
                .where(
                  inArray(profiles.id, [caller.profileId, targetProfileId])
                )
            )
            const me = found.find((one) => one.id === caller.profileId)
            const them = found.find(
              (one) => one.id.toLowerCase() === targetProfileId.toLowerCase()
            )

            // PRODUCT.md, Identity: "A person checks every profile before it
            // goes live." Neither side is in the pool until approved, and an
            // expired profile is as good as missing: its agent is not
            // listening.
            if (me === undefined || me.reviewStatus !== 'approved') {
              return yield* new NotFound()
            }
            if (
              them === undefined ||
              them.reviewStatus !== 'approved' ||
              them.lastSeenAt.getTime() <= activeSince.getTime()
            ) {
              return yield* new NotFound()
            }

            const { aId, bId, side } = pairOf(caller.profileId, them.id)

            const existing = yield* rowByPair(aId, bId)
            if (
              existing !== undefined &&
              effectiveStatus(existing, at) !== 'expired'
            ) {
              return yield* joinExisting(caller, existing, side, at)
            }

            yield* enforceCap(caller.profileId, at)

            if (existing !== undefined) {
              // Only a no closes a pair for good. An expired setup is
              // history: delete it, guarded on it still being expired, and
              // start a fresh one with a new id and a new date below.
              const removed = yield* query(
                db
                  .delete(setups)
                  .where(
                    and(
                      eq(setups.id, existing.id),
                      inArray(setups.status, [...OPEN, 'expired']),
                      or(eq(setups.status, 'expired'), not(liveAt(at)))
                    )
                  )
                  .returning({ id: setups.id })
              )
              if (removed.length === 0) {
                // Someone restarted or settled it first; answer from that.
                const fresh = yield* rowByPair(aId, bId)
                if (fresh !== undefined) {
                  return yield* joinExisting(caller, fresh, side, at)
                }
              }
            }

            const party = (one: typeof me): DateParty => ({
              profileId: one.id,
              city: one.city,
              country: one.country,
              availability: one.availability,
            })
            const date = yield* suggester.suggest({
              a: party(me),
              b: party(them),
            })

            const inserted = yield* query(
              db
                .insert(setups)
                .values({
                  profileAId: aId,
                  profileBId: bId,
                  status: 'suggested',
                  interestedAAt: side === 'a' ? new Date(at) : null,
                  interestedBAt: side === 'b' ? new Date(at) : null,
                  date: encodeDate(date),
                  createdAt: new Date(at),
                  updatedAt: new Date(at),
                  expiresAt: new Date(at + SETUP_TTL_MS),
                })
                .onConflictDoNothing({
                  target: [setups.profileAId, setups.profileBId],
                })
                .returning()
            )

            const created = inserted[0]
            if (created !== undefined) {
              return new InterestResponse({
                setup: yield* viewOf(created, side, at),
              })
            }

            // The other side picked the same pair between the read and the
            // insert. Their row is the row; join it.
            const raced = yield* rowByPair(aId, bId)
            if (raced === undefined) {
              return yield* Effect.dieMessage(
                'setup insert conflicted with a row that is not there'
              )
            }
            return yield* joinExisting(caller, raced, side, at)
          }),

        /**
         * The caller's human says yes to the suggested date. The first yes
         * sends the date request to the other side; the second confirms the
         * date and releases the other's phone number.
         */
        confirm: (
          caller: AuthenticatedProfile,
          setupId: SetupId
        ): Effect.Effect<ConfirmResponse, NotFound | Conflict> =>
          Effect.gen(function* () {
            // Two yeses can cross: both read the row before either wrote. The
            // loser of the guard looks once more and sees the other's yes.
            const first = yield* confirmOnce(caller, setupId)
            if (first !== undefined) return first
            const second = yield* confirmOnce(caller, setupId)
            if (second !== undefined) return second
            return yield* staleConflict(caller, setupId)
          }),

        /**
         * Either side ends the setup. PRODUCT.md, Voice: "No is always
         * enough." — nothing is carried but the setup id, and the other side
         * is told the status and not one word more.
         *
         * Final. `declined` is settled, so the row never expires and nothing
         * revives it; it stays in the table, which is what keeps the pair out
         * of each other's candidates for good. `expiresAt` is left where it
         * was rather than pushed: a settled row is not waiting for anything.
         */
        decline: (
          caller: AuthenticatedProfile,
          setupId: SetupId
        ): Effect.Effect<DeclineResponse, NotFound | Conflict> =>
          Effect.gen(function* () {
            const { row } = yield* visibleRow(caller, setupId)
            const at = yield* Clock.currentTimeMillis
            const status = effectiveStatus(row, at)

            if (!isOpen(status)) return yield* new Conflict({ status })

            const updated = yield* query(
              db
                .update(setups)
                .set({ status: 'declined', updatedAt: new Date(at) })
                .where(
                  and(
                    eq(setups.id, row.id),
                    inArray(setups.status, [...OPEN]),
                    liveAt(at)
                  )
                )
                .returning({ id: setups.id })
            )
            if (updated.length === 0) {
              return yield* staleConflict(caller, setupId)
            }

            return new DeclineResponse({ status: 'declined' })
          }),

        /** Every setup this caller can see, newest first. */
        listFor: (
          caller: AuthenticatedProfile
        ): Effect.Effect<SetupsResponse> =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis

            const rows = yield* query(
              db
                .select()
                .from(setups)
                .where(
                  or(
                    eq(setups.profileAId, caller.profileId),
                    eq(setups.profileBId, caller.profileId)
                  )
                )
                .orderBy(desc(setups.createdAt), desc(setups.id))
            )

            const mine: Array<{ readonly row: SetupRow; readonly side: Side }> =
              []
            for (const row of rows) {
              const side = sideIn(row, caller.profileId)
              if (side !== null && visibleTo(row, side))
                mine.push({ row, side })
            }

            const people = yield* peopleById(
              mine.map(({ row, side }) => counterpartIdOf(row, side))
            )

            const result: Array<Setup> = []
            for (const { row, side } of mine) {
              result.push(yield* toSetup(row, side, at, people))
            }

            return new SetupsResponse({ setups: result })
          }),
      }
    }),
  }
) {}
