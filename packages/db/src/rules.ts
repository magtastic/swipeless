import type { SetupStatus } from '@swipeless/shared'
import { gt, type SQL, sql } from 'drizzle-orm'
import { profiles } from './schema/profiles.ts'
import { type SetupRow, setups } from './schema/setups.ts'

/**
 * The product's expiry rules, each written once, in the two forms callers
 * need: a predicate over a row already in hand, and the same rule as SQL for a
 * query that filters, groups or guards on it. Imported as
 * `@swipeless/db/rules`.
 *
 * Nothing walks the tables to expire anything. A profile or a setup is expired
 * because these say so at the instant asked about, and the instant is always
 * the caller's, read from Effect's `Clock`, never `now()` in SQL, so a test
 * clock moves both forms together.
 */

export const DAY_MS = 24 * 60 * 60 * 1000

/** PRODUCT.md: "Profiles expire automatically after ninety days without a check-in." */
export const PROFILE_TTL_DAYS = 90
export const PROFILE_TTL_MS = PROFILE_TTL_DAYS * DAY_MS

/** A profile is live while its last check-in is later than this. */
export const liveSince = (at: number): Date => new Date(at - PROFILE_TTL_MS)

export const isLive = (lastSeenAt: Date, at: number): boolean =>
  lastSeenAt.getTime() > liveSince(at).getTime()

export const isLiveSql = (at: number): SQL =>
  gt(profiles.lastSeenAt, liveSince(at))

/**
 * Statuses that no longer age out. PRODUCT.md: "A confirmed setup does not
 * expire", and a declined or expired one has nothing left to wait for.
 */
export const SETTLED_STATUSES: ReadonlySet<SetupStatus> = new Set<SetupStatus>([
  'confirmed',
  'declined',
  'expired',
])

/**
 * An unsettled setup is still running while it has neither gone fourteen
 * days without a transition nor passed its suggested time: a date in the
 * past is not a date anyone can still say yes to.
 */
const runningAt = (row: Pick<SetupRow, 'expiresAt' | 'date'>, at: number) =>
  row.expiresAt.getTime() > at && Date.parse(row.date.time) > at

/** `runningAt` in SQL, for guarded writes. Stored date times are ISO-8601. */
export const setupRunningSql = (at: number): SQL =>
  sql`(${setups.expiresAt} > ${new Date(at)} and (${setups.date}->>'time')::timestamptz > ${new Date(at)})`

/**
 * The status the outside world sees. An unsettled row that is no longer
 * running reads as `expired`, whatever the stored column says, so every
 * reader answers from this and never from the column.
 */
export const effectiveStatus = (
  row: Pick<SetupRow, 'status' | 'expiresAt' | 'date'>,
  at: number
): SetupStatus =>
  SETTLED_STATUSES.has(row.status) || runningAt(row, at)
    ? row.status
    : 'expired'

/** `effectiveStatus` as a SQL expression over `setups`. */
export const effectiveStatusSql = (at: number): SQL<SetupStatus> => {
  // Constants from the set above, not input, so inlining them is safe and
  // keeps Postgres comparing enum to enum.
  const settled = sql.raw(
    [...SETTLED_STATUSES].map((status) => `'${status}'`).join(', ')
  )
  return sql<SetupStatus>`case
    when ${setups.status} in (${settled}) then ${setups.status}
    when ${setupRunningSql(at)} then ${setups.status}
    else 'expired'::setup_status
  end`
}
