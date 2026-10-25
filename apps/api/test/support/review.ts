import { PgDrizzle } from '@swipeless/db'
import { profiles } from '@swipeless/db/schema'
import type { ProfileId } from '@swipeless/shared'
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'

/**
 * Stands in for the person at swipeless who checks each profile (the admin
 * review queue): nobody is matched until approved, so tests that want a match
 * approve first.
 */
export const approve = (profileId: ProfileId) =>
  PgDrizzle.PgDrizzle.pipe(
    Effect.flatMap((db) =>
      db
        .update(profiles)
        .set({ reviewStatus: 'approved', reviewedAt: new Date() })
        .where(eq(profiles.id, profileId))
    ),
    Effect.orDie,
    Effect.asVoid
  )
