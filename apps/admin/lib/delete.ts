import { DbLive, PgDrizzle } from '@swipeless/db'
import { adminEvents, profiles } from '@swipeless/db/schema'
import { ProfilePhotos, ProfilePhotosLive } from '@swipeless/photos'
import { eq } from 'drizzle-orm'
import { Cause, Clock, Effect } from 'effect'
import { isSuperAdmin } from './access.ts'

/**
 * SHOWCASE ONLY: the super admin clears rehearsal profiles before the demo.
 *
 * Mirrors `deleteProfile` in apps/api/src/service.ts, which reads the profile
 * from the caller's token and so cannot be shared: discard the photo, delete
 * the row (the cascade takes the setups), and record `profile.deleted`. Keep
 * the two in step.
 */

export type DeleteOutcome =
  | { readonly _tag: 'Deleted' }
  /** Not the super admin. Nothing was read or written. */
  | { readonly _tag: 'Forbidden' }
  /** Already gone, or not a profile id. Nothing was written. */
  | { readonly _tag: 'NotFound' }
  | { readonly _tag: 'Unavailable'; readonly reason: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const removeProfile = (
  profileId: string,
  verifiedEmail: string | null | undefined
) =>
  Effect.gen(function* () {
    if (!isSuperAdmin(verifiedEmail)) return { _tag: 'Forbidden' } as const
    if (!UUID.test(profileId)) return { _tag: 'NotFound' } as const

    const db = yield* PgDrizzle.PgDrizzle
    const photos = yield* ProfilePhotos
    const at = new Date(yield* Clock.currentTimeMillis)

    const rows = yield* db
      .select({ photoUrl: profiles.photoUrl })
      .from(profiles)
      .where(eq(profiles.id, profileId))
    const [row] = rows
    if (!row) return { _tag: 'NotFound' } as const
    if (row.photoUrl) yield* photos.discard(row.photoUrl)
    yield* db.delete(profiles).where(eq(profiles.id, profileId))

    yield* db.insert(adminEvents).values({
      kind: 'profile.deleted',
      profileId,
      payload: {},
      createdAt: at,
    })
    return { _tag: 'Deleted' } as const
  })

/** Pass only the email from the server-verified session. Never throws. */
export const deleteProfileAsAdmin = (
  profileId: string,
  verifiedEmail: string | null | undefined
): Promise<DeleteOutcome> =>
  // Refused before the layers are built, so a non-super admin never connects.
  isSuperAdmin(verifiedEmail)
    ? Effect.runPromise(
        removeProfile(profileId, verifiedEmail).pipe(
          Effect.provide(ProfilePhotosLive),
          Effect.provide(DbLive),
          Effect.catchAllCause((cause) =>
            Effect.succeed({
              _tag: 'Unavailable',
              reason: Cause.pretty(cause),
            } as const)
          )
        )
      )
    : Promise.resolve({ _tag: 'Forbidden' })
