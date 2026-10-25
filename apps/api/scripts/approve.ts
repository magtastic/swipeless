import { DbLive, PgDrizzle } from '@swipeless/db'
import { adminEvents, profiles } from '@swipeless/db/schema'
import { and, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { guardDatabaseTarget } from './local-only.ts'

/**
 * Approves profiles without the admin review queue, for demos and local dev.
 *
 *   bun run approve <profileId>
 *   bun run approve --all-pending
 *   … --allow-remote          # write to a non-local DATABASE_URL
 *
 * Writes what the queue writes: reviewStatus, reviewedAt, and a
 * `profile.approved` admin event per profile. Only pending profiles move, so
 * a rejected profile stays rejected. Reads DATABASE_URL like the app.
 */

const target = process.argv.slice(2).find((arg) => arg !== '--allow-remote')
if (target === undefined) {
  console.error('usage: bun run approve <profileId|--all-pending>')
  process.exit(1)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
if (target !== '--all-pending' && !UUID.test(target)) {
  console.error(`not a profile id: ${target}`)
  process.exit(1)
}

guardDatabaseTarget(process.argv)

const approve = Effect.gen(function* () {
  const db = yield* PgDrizzle.PgDrizzle
  const at = new Date()

  const approved = yield* db
    .update(profiles)
    .set({ reviewStatus: 'approved', reviewedAt: at })
    .where(
      target === '--all-pending'
        ? eq(profiles.reviewStatus, 'pending')
        : and(eq(profiles.id, target), eq(profiles.reviewStatus, 'pending'))
    )
    .returning({ id: profiles.id, firstName: profiles.firstName })

  if (approved.length > 0) {
    yield* db.insert(adminEvents).values(
      approved.map((one) => ({
        kind: 'profile.approved',
        profileId: one.id,
        payload: { via: 'script' },
        createdAt: at,
      }))
    )
  }

  console.log(`Approved ${approved.length} profile(s).`)
  for (const one of approved) console.log(`  ${one.id}  ${one.firstName}`)
})

await Effect.runPromise(approve.pipe(Effect.provide(DbLive)))
