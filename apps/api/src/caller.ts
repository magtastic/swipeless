import { PgDrizzle } from '@swipeless/db'
import { isLive } from '@swipeless/db/rules'
import { profiles } from '@swipeless/db/schema'
import { Gone, Unauthorized } from '@swipeless/shared'
import { eq } from 'drizzle-orm'
import { Clock, Effect, Redacted } from 'effect'
import type { AuthenticatedProfile } from './service.ts'
import { hashToken } from './token.ts'

/**
 * Resolving a bearer token to the profile behind it. This is the only place
 * that turns a token into a `profileId`, so REST and MCP cannot disagree about
 * who the caller is, and no other module ever sees a token.
 *
 * A resolve is also the check-in PRODUCT.md talks about: every authenticated
 * call bumps `last_seen_at`, and a profile that has not checked in for ninety
 * days is `Gone` rather than `Unauthorized` — the difference matters to the
 * agent, which can republish rather than hunt for a lost token.
 *
 * Time comes from `Clock`, never from `now()` in SQL, so `TestClock` can walk a
 * profile over the expiry line.
 */

/** `Bearer <token>`, case-insensitive scheme, surrounding space ignored. */
const BEARER = /^bearer[ \t]+(\S+)[ \t]*$/i

/**
 * Parses an `authorization` header value into the token it carries. Pure, and
 * shared: the REST middleware gets the token parsed for it by the platform,
 * but the MCP adapter reads the raw header off the request itself.
 */
export const tokenFromAuthorization = (
  authorization: string | undefined
): Effect.Effect<string, Unauthorized> => {
  const token =
    authorization === undefined ? undefined : BEARER.exec(authorization)?.[1]
  return token === undefined
    ? Effect.fail(new Unauthorized())
    : Effect.succeed(token)
}

/**
 * `dependencies` is empty for the same reason `Swipeless`'s is: the database
 * is a requirement the layer's builder supplies, so production points this at
 * Postgres and the tests point the same code at TEST_DATABASE_URL.
 */
export class Caller extends Effect.Service<Caller>()('Caller', {
  dependencies: [],
  effect: Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle

    return {
      resolve: (
        token: Redacted.Redacted<string> | string
      ): Effect.Effect<AuthenticatedProfile, Unauthorized | Gone> =>
        Effect.gen(function* () {
          const millis = yield* Clock.currentTimeMillis
          const secret =
            typeof token === 'string' ? token : Redacted.value(token)

          // Only the hash is stored, so the lookup is by hash and a database
          // dump hands out nothing.
          const found = yield* db
            .select({ id: profiles.id, lastSeenAt: profiles.lastSeenAt })
            .from(profiles)
            .where(eq(profiles.tokenHash, hashToken(secret)))
            .limit(1)
            .pipe(Effect.orDie)

          const row = found[0]
          // No row covers both a token that was never issued and one whose
          // profile has been deleted: deletion is a hard delete, so a deleted
          // token reads as Unauthorized, not Gone.
          if (row === undefined) {
            return yield* new Unauthorized()
          }
          if (!isLive(row.lastSeenAt, millis)) {
            return yield* new Gone()
          }

          yield* db
            .update(profiles)
            .set({ lastSeenAt: new Date(millis) })
            .where(eq(profiles.id, row.id))
            .pipe(Effect.orDie)

          return { profileId: row.id }
        }),
    }
  }),
}) {}
