import { DbLive, PgDrizzle } from '@swipeless/db'
import { profiles } from '@swipeless/db/schema'
import { asc, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { isSuperAdmin } from './access.ts'

/**
 * Local test tools. Acting as someone breaks PRODUCT.md, Trust ("the human,
 * not the AI, says yes to every date"), so they exist only outside production
 * and only for the super admin.
 */

export const testToolsEnabled = (verifiedEmail: string | null | undefined) =>
  process.env.NODE_ENV !== 'production' && isSuperAdmin(verifiedEmail)

export interface TestPerson {
  readonly id: string
  readonly firstName: string
}

/** Approved people, by first name. Empty when the tools are off. */
export const loadTestPeople = (
  verifiedEmail: string | null | undefined
): Promise<ReadonlyArray<TestPerson>> =>
  testToolsEnabled(verifiedEmail)
    ? Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* PgDrizzle.PgDrizzle
          return yield* db
            .select({ id: profiles.id, firstName: profiles.firstName })
            .from(profiles)
            .where(eq(profiles.reviewStatus, 'approved'))
            .orderBy(asc(profiles.firstName))
            .limit(200)
        }).pipe(
          Effect.provide(DbLive),
          Effect.catchAllCause(() => Effect.succeed([]))
        )
      )
    : Promise.resolve([])
