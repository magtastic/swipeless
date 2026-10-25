import { DbLive, PgDrizzle } from '@swipeless/db'
import {
  DAY_MS,
  effectiveStatusSql,
  isLive,
  isLiveSql,
  liveSince,
} from '@swipeless/db/rules'
import { adminEvents, profiles, setups } from '@swipeless/db/schema'
import { adminPhotoPath } from '@swipeless/photos'
import {
  REVIEW_STATUSES,
  type ReviewStatus,
  SETUP_STATUSES,
  type SetupStatus,
} from '@swipeless/shared'
import { and, desc, inArray, lte, not, sql } from 'drizzle-orm'
import { Cause, Clock, Effect, Schema } from 'effect'
import { isSuperAdmin } from './access.ts'

/**
 * Everything the console reads out of Postgres.
 *
 * This module is the only place in the admin app that talks to the database:
 * it builds the layer, runs the queries and hands back plain data, so the
 * components stay dumb and never import Effect.
 *
 * Profile overviews select the published brief and matching fields explicitly.
 * The note (first name, photo) and the private details (phone, plus the
 * optional email and standing instructions) are queried only for the super
 * admin, identified by a verified session email. Token hashes are never
 * selected.
 */

/** How close to the 90-day cutoff counts as "about to go". */
const EXPIRING_SOON_DAYS = 7

export interface ProfileCounts {
  readonly total: number
  readonly live: number
  readonly expiringSoon: number
  readonly expired: number
  /** By review status, every row regardless of expiry. */
  readonly review: Readonly<Record<ReviewStatus, number>>
}

export interface SetupCount {
  readonly status: SetupStatus
  readonly count: number
}

export interface AdminEvent {
  readonly id: string
  readonly kind: string
  readonly profileId: string | null
  /** ISO-8601, formatted here so the component does no date work. */
  readonly createdAt: string
}

export const ProfileOverview = Schema.Struct({
  id: Schema.String,
  age: Schema.Number,
  gender: Schema.String,
  interestedIn: Schema.Array(Schema.String),
  city: Schema.String,
  country: Schema.String,
  radiusKm: Schema.Number,
  availability: Schema.String,
  brief: Schema.String,
  reviewStatus: Schema.Literal(...REVIEW_STATUSES),
  createdAt: Schema.String,
  lastSeenAt: Schema.String,
  expired: Schema.Boolean,
  /** What the note shows the one person a date is with. Super admin only. */
  note: Schema.optional(
    Schema.Struct({
      firstName: Schema.String,
      photoUrl: Schema.NullOr(Schema.String),
    })
  ),
  /** The phone is the private layer; email and instructions are optional extras. */
  privateDetails: Schema.optional(
    Schema.Struct({
      phone: Schema.String,
      email: Schema.NullOr(Schema.String),
      standingInstructions: Schema.NullOr(Schema.String),
    })
  ),
})
export type ProfileOverview = typeof ProfileOverview.Type

export const PROFILE_PAGE_SIZE = 20

export interface Dashboard {
  readonly profiles: ProfileCounts
  readonly overviews: ReadonlyArray<ProfileOverview>
  readonly hasMoreProfiles: boolean
  readonly setups: ReadonlyArray<SetupCount>
  readonly events: ReadonlyArray<AdminEvent>
}

export type DashboardResult =
  | { readonly _tag: 'Loaded'; readonly dashboard: Dashboard }
  | { readonly _tag: 'Unavailable'; readonly reason: string }

/** Matches the API's lazy expiry: nothing walks the tables, the cutoff does. */
const countProfiles = (at: number) =>
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle
    const live = isLiveSql(at)
    // Live now, gone by the time a week has passed.
    const expiring = and(
      live,
      lte(profiles.lastSeenAt, liveSince(at + EXPIRING_SOON_DAYS * DAY_MS))
    )

    const rows = yield* db
      .select({
        total: sql<number>`count(*)::int`,
        live: sql<number>`(count(*) filter (where ${live}))::int`,
        expiringSoon: sql<number>`(count(*) filter (where ${expiring}))::int`,
        expired: sql<number>`(count(*) filter (where ${not(live)}))::int`,
        pending: sql<number>`(count(*) filter (
          where ${profiles.reviewStatus} = 'pending'
        ))::int`,
        approved: sql<number>`(count(*) filter (
          where ${profiles.reviewStatus} = 'approved'
        ))::int`,
        rejected: sql<number>`(count(*) filter (
          where ${profiles.reviewStatus} = 'rejected'
        ))::int`,
      })
      .from(profiles)

    const row = rows[0]
    return {
      total: row?.total ?? 0,
      live: row?.live ?? 0,
      expiringSoon: row?.expiringSoon ?? 0,
      expired: row?.expired ?? 0,
      review: {
        pending: row?.pending ?? 0,
        approved: row?.approved ?? 0,
        rejected: row?.rejected ?? 0,
      },
    } satisfies ProfileCounts
  })

/**
 * Grouped by the status the agents actually see: the same `effectiveStatus`
 * rule the API answers from, in its SQL form, so the console's numbers cannot
 * drift from the product's.
 *
 * Exported for tests.
 */
export const countSetups = (at: number) =>
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle
    const status = effectiveStatusSql(at)

    /**
     * By ordinal, not by the expression again: drizzle qualifies column
     * references inside `groupBy` (`"setups"."status"`) but not in the select
     * list (`"status"`), and Postgres then reads the two CASEs as different
     * expressions and rejects the query.
     */
    const rows = yield* db
      .select({ status, count: sql<number>`count(*)::int` })
      .from(setups)
      .groupBy(sql`1`)

    const counted = new Map(rows.map((row) => [row.status, row.count]))
    return SETUP_STATUSES.map(
      (value): SetupCount => ({ status: value, count: counted.get(value) ?? 0 })
    )
  })

/** The audit trail. `payload` is deliberately not selected: it is free-form. */
const recentEvents = Effect.gen(function* () {
  const db = yield* PgDrizzle.PgDrizzle
  const rows = yield* db
    .select({
      id: adminEvents.id,
      kind: adminEvents.kind,
      profileId: adminEvents.profileId,
      createdAt: adminEvents.createdAt,
    })
    .from(adminEvents)
    .orderBy(desc(adminEvents.createdAt))
    .limit(50)

  return rows.map(
    (row): AdminEvent => ({
      id: row.id,
      kind: row.kind,
      profileId: row.profileId,
      createdAt: row.createdAt.toISOString(),
    })
  )
})

export const profileOverviews = (
  at: number,
  page: number,
  verifiedEmail?: string | null
) =>
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle
    const rows = yield* db
      .select({
        id: profiles.id,
        age: profiles.age,
        gender: profiles.gender,
        interestedIn: profiles.interestedIn,
        city: profiles.city,
        country: profiles.country,
        radiusKm: profiles.radiusKm,
        availability: profiles.availability,
        brief: profiles.brief,
        reviewStatus: profiles.reviewStatus,
        createdAt: profiles.createdAt,
        lastSeenAt: profiles.lastSeenAt,
      })
      .from(profiles)
      .orderBy(desc(profiles.createdAt), desc(profiles.id))
      .limit(PROFILE_PAGE_SIZE + 1)
      .offset((page - 1) * PROFILE_PAGE_SIZE)
    const visibleRows = rows.slice(0, PROFILE_PAGE_SIZE)
    // Ordinary admins never execute this query or receive these fields in RSC payloads.
    const privateRows =
      isSuperAdmin(verifiedEmail) && visibleRows.length > 0
        ? yield* db
            .select({
              id: profiles.id,
              firstName: profiles.firstName,
              phone: profiles.phone,
              email: profiles.email,
              photoUrl: profiles.photoUrl,
              standingInstructions: profiles.standingInstructions,
            })
            .from(profiles)
            .where(
              inArray(
                profiles.id,
                visibleRows.map((row) => row.id)
              )
            )
        : []
    const superById = new Map(
      privateRows.map(({ id, firstName, photoUrl, ...details }) => [
        id,
        {
          note: {
            firstName,
            photoUrl: adminPhotoPath(photoUrl, id),
          },
          privateDetails: details,
        },
      ])
    )
    return {
      overviews: visibleRows.map(
        (row): ProfileOverview => ({
          ...row,
          ...superById.get(row.id),
          createdAt: row.createdAt.toISOString(),
          lastSeenAt: row.lastSeenAt.toISOString(),
          expired: !isLive(row.lastSeenAt, at),
        })
      ),
      hasMoreProfiles: rows.length > PROFILE_PAGE_SIZE,
    }
  })

const dashboard = (page: number, verifiedEmail: string | null | undefined) =>
  Effect.gen(function* () {
    const at = yield* Clock.currentTimeMillis
    const [counts, statuses, events, overviewPage] = yield* Effect.all(
      [
        countProfiles(at),
        countSetups(at),
        recentEvents,
        profileOverviews(at, page, verifiedEmail),
      ],
      { concurrency: 'unbounded' }
    )
    return {
      profiles: counts,
      setups: statuses,
      events,
      ...overviewPage,
    } satisfies Dashboard
  })

/**
 * Runs the whole page's reads, or explains why it could not.
 *
 * Nothing here is allowed to throw: `next build` runs with no DATABASE_URL at
 * all, and a console that 500s the moment Postgres blinks is worse than one
 * that says so. The layer is built per call rather than memoized so a database
 * that comes back does not stay broken behind a cached failed layer; the
 * console is low traffic and the queries are small.
 *
 * The connection string is `Config.redacted`, so the password cannot reach
 * this string.
 */
export const loadDashboard = (
  page: number,
  verifiedEmail: string | null | undefined
): Promise<DashboardResult> =>
  Effect.runPromise(
    dashboard(page, verifiedEmail).pipe(
      Effect.map((value) => ({ _tag: 'Loaded', dashboard: value }) as const),
      Effect.provide(DbLive),
      Effect.catchAllCause((cause) =>
        Effect.succeed({
          _tag: 'Unavailable',
          reason: Cause.pretty(cause),
        } as const)
      )
    )
  )
