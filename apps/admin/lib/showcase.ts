import { DbLive, PgDrizzle } from '@swipeless/db'
import { profiles } from '@swipeless/db/schema'
import { and, desc, eq, ne } from 'drizzle-orm'
import { Effect } from 'effect'
import { isSuperAdmin } from './access.ts'

/**
 * SHOWCASE ONLY (docs/decisions.md, 2026-10-26): the fallback for the staged
 * date request, for the super admin, and only while SHOWCASE_MATCH_PROFILE_ID
 * is set. Unlike the test tools it shows in production: that is where the
 * demo runs.
 */

const matchId = () => process.env.SHOWCASE_MATCH_PROFILE_ID?.trim()

export const showcaseEnabled = (verifiedEmail: string | null | undefined) =>
  isSuperAdmin(verifiedEmail) && Boolean(matchId())

export interface ShowcaseTarget {
  readonly id: string
  readonly firstName: string
  /** Published with SHOWCASE_PHONE: the presenter. */
  readonly presenter: boolean
}

const digits = (phone: string) => phone.replace(/\D/g, '')

/** The newest live profiles, the presenter's first. Empty when off. */
export const loadShowcaseTargets = (
  verifiedEmail: string | null | undefined
): Promise<ReadonlyArray<ShowcaseTarget>> => {
  const match = matchId()
  if (!showcaseEnabled(verifiedEmail) || match === undefined) {
    return Promise.resolve([])
  }
  const presenter = digits(process.env.SHOWCASE_PHONE ?? '')
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle
      const rows = yield* db
        .select({
          id: profiles.id,
          firstName: profiles.firstName,
          phone: profiles.phone,
        })
        .from(profiles)
        .where(
          and(eq(profiles.reviewStatus, 'approved'), ne(profiles.id, match))
        )
        .orderBy(desc(profiles.createdAt))
        .limit(30)
      const targets = rows.map((row) => ({
        id: row.id,
        firstName: row.firstName,
        presenter: presenter !== '' && digits(row.phone) === presenter,
      }))
      return [
        ...targets.filter((one) => one.presenter),
        ...targets.filter((one) => !one.presenter),
      ]
    }).pipe(
      Effect.provide(DbLive),
      Effect.catchAllCause(() => Effect.succeed([]))
    )
  )
}
