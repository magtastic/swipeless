import { DbLive, PgDrizzle } from '@swipeless/db'
import { adminEvents, profiles } from '@swipeless/db/schema'
import { adminPhotoPath } from '@swipeless/photos'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import { Cause, Clock, Effect } from 'effect'
import { isSuperAdmin } from './access.ts'

/**
 * The review queue. PRODUCT.md, Identity: "A person checks every profile
 * before it goes live, including that they are 18+." Only approved profiles
 * are ever matched, so this is the gate.
 *
 * Like `dashboard.ts`, this is the only way the components reach Postgres for
 * reviews: plain data and promises out, no Effect in the components.
 *
 * First name and photo are what the note shows to the one person a date is
 * with, and the phone stays out of this module entirely. The reviewer needs
 * the photo to check the person is real and an adult, so the note fields are
 * read for the super admin only, like every other personal field in the
 * console. Ordinary admins see the published brief and the core.
 */

export interface PendingNote {
  readonly firstName: string
  /** `/api/photos/{id}` for a stored photo, an external https URL, or null. */
  readonly photoUrl: string | null
}

export interface PendingProfile {
  readonly id: string
  readonly age: number
  readonly gender: string
  readonly city: string
  readonly country: string
  readonly brief: string
  /** ISO-8601. */
  readonly createdAt: string
  /** Present for the super admin only. */
  readonly note?: PendingNote
}

export interface ReviewQueue {
  readonly pending: ReadonlyArray<PendingProfile>
  /** True when more are waiting than were loaded. */
  readonly hasMore: boolean
  /** Whether this viewer may approve and reject. */
  readonly canDecide: boolean
}

export type ReviewQueueResult =
  | { readonly _tag: 'Loaded'; readonly queue: ReviewQueue }
  | { readonly _tag: 'Unavailable'; readonly reason: string }

export const REVIEW_QUEUE_SIZE = 25

export type ReviewDecision = 'approved' | 'rejected'

export type ReviewOutcome =
  | { readonly _tag: 'Decided'; readonly decision: ReviewDecision }
  /** Not the super admin. Nothing was read or written. */
  | { readonly _tag: 'Forbidden' }
  /** Gone, or already reviewed. Nothing was written. */
  | { readonly _tag: 'NotPending' }
  | { readonly _tag: 'Unavailable'; readonly reason: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Pending profiles, oldest first: whoever has waited longest goes next. */
export const reviewQueue = (verifiedEmail: string | null | undefined) =>
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle
    const superAdmin = isSuperAdmin(verifiedEmail)
    const rows = yield* db
      .select({
        id: profiles.id,
        age: profiles.age,
        gender: profiles.gender,
        city: profiles.city,
        country: profiles.country,
        brief: profiles.brief,
        createdAt: profiles.createdAt,
      })
      .from(profiles)
      .where(eq(profiles.reviewStatus, 'pending'))
      .orderBy(asc(profiles.createdAt), asc(profiles.id))
      .limit(REVIEW_QUEUE_SIZE + 1)
    const visible = rows.slice(0, REVIEW_QUEUE_SIZE)

    // Ordinary admins never run this query, so the fields never reach them.
    const notes =
      superAdmin && visible.length > 0
        ? yield* db
            .select({
              id: profiles.id,
              firstName: profiles.firstName,
              photoUrl: profiles.photoUrl,
            })
            .from(profiles)
            .where(
              inArray(
                profiles.id,
                visible.map((row) => row.id)
              )
            )
        : []
    const noteById = new Map(
      notes.map((row) => [
        row.id,
        {
          firstName: row.firstName,
          photoUrl: adminPhotoPath(row.photoUrl, row.id),
        } satisfies PendingNote,
      ])
    )

    return {
      pending: visible.map((row): PendingProfile => {
        const note = noteById.get(row.id)
        return {
          ...row,
          createdAt: row.createdAt.toISOString(),
          ...(note ? { note } : {}),
        }
      }),
      hasMore: rows.length > REVIEW_QUEUE_SIZE,
      canDecide: superAdmin,
    } satisfies ReviewQueue
  })

/**
 * Approve or reject one pending profile, for the super admin only.
 *
 * One statement, so the status change and its audit row land together or not
 * at all, and only a profile still `pending` is touched: two tabs deciding the
 * same profile record one decision. The event payload is empty on purpose; the
 * kind and the profile id say everything the audit trail needs.
 */
export const decideReview = (
  profileId: string,
  decision: ReviewDecision,
  verifiedEmail: string | null | undefined
) =>
  Effect.gen(function* () {
    if (!isSuperAdmin(verifiedEmail)) {
      return { _tag: 'Forbidden' } as const
    }
    if (!UUID.test(profileId)) return { _tag: 'NotPending' } as const

    const db = yield* PgDrizzle.PgDrizzle
    const at = new Date(yield* Clock.currentTimeMillis).toISOString()
    const kind =
      decision === 'approved' ? 'profile.approved' : 'profile.rejected'

    /**
     * Two data-modifying CTEs in one statement. Written as SQL because the
     * builder cannot put an UPDATE in a CTE; the typed selections let drizzle
     * map the result back. Column names are spelled out: Postgres rejects
     * table-qualified names in SET.
     */
    const decided = db.$with('decided', { id: profiles.id }).as(sql`
      update profiles
      set review_status = ${decision}::review_status,
          reviewed_at = ${at}::timestamptz
      where id = ${profileId}::uuid and review_status = 'pending'
      returning id
    `)
    const logged = db
      .$with('logged', { profileId: adminEvents.profileId })
      .as(sql`
        insert into admin_events (kind, profile_id, payload, created_at)
        select ${kind}, id, '{}'::jsonb, ${at}::timestamptz from decided
        returning profile_id
      `)
    const rows = yield* db
      .with(decided, logged)
      .select({ profileId: logged.profileId })
      .from(logged)

    return rows.length === 0
      ? ({ _tag: 'NotPending' } as const)
      : ({ _tag: 'Decided', decision } as const)
  })

const unavailable = (cause: Cause.Cause<unknown>) =>
  Effect.succeed({ _tag: 'Unavailable', reason: Cause.pretty(cause) } as const)

/** Never throws, for the same reasons as `loadDashboard`. */
export const loadReviewQueue = (
  verifiedEmail: string | null | undefined
): Promise<ReviewQueueResult> =>
  Effect.runPromise(
    reviewQueue(verifiedEmail).pipe(
      Effect.map((queue) => ({ _tag: 'Loaded', queue }) as const),
      Effect.provide(DbLive),
      Effect.catchAllCause(unavailable)
    )
  )

/** Pass only the email from the server-verified session. Never throws. */
export const recordReview = (
  profileId: string,
  decision: ReviewDecision,
  verifiedEmail: string | null | undefined
): Promise<ReviewOutcome> =>
  // Refused before the layer is built, so a non-super admin never connects.
  isSuperAdmin(verifiedEmail)
    ? Effect.runPromise(
        decideReview(profileId, decision, verifiedEmail).pipe(
          Effect.provide(DbLive),
          Effect.catchAllCause(unavailable)
        )
      )
    : Promise.resolve({ _tag: 'Forbidden' })
