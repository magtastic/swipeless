import { DbLive, PgDrizzle } from '@swipeless/db'
import { profiles } from '@swipeless/db/schema'
import { ProfilePhotos, ProfilePhotosLive } from '@swipeless/photos'
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { auth } from '../../../../auth.ts'
import { isSuperAdmin } from '../../../../lib/access.ts'

export const dynamic = 'force-dynamic'
export async function GET(
  request: Request,
  { params }: { params: Promise<{ profileId: string }> }
) {
  const { profileId } = await params
  const headers = {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      profileId
    )
  )
    return new Response(null, { status: 404, headers })
  const session = await auth()
  const link = new URL(request.url).searchParams
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const photos = yield* ProfilePhotos
      if (
        !isSuperAdmin(session?.user?.email) &&
        !(yield* photos.verifyLink(profileId, link))
      )
        return null
      const db = yield* PgDrizzle.PgDrizzle
      const rows = yield* db
        .select({ photoUrl: profiles.photoUrl })
        .from(profiles)
        .where(eq(profiles.id, profileId))
        .limit(1)
      const reference = rows[0]?.photoUrl
      return reference ? yield* photos.read(reference) : null
    }).pipe(
      Effect.provide(DbLive),
      Effect.provide(ProfilePhotosLive),
      Effect.catchAllCause(() => Effect.succeed(null))
    )
  )
  if (!result) return new Response(null, { status: 404, headers })
  return new Response(Buffer.from(result.bytes), {
    headers: { ...headers, 'Content-Type': result.contentType },
  })
}
