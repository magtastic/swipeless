import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { inlinePhotoProblem } from '@swipeless/shared'
import { del, get, put } from '@vercel/blob'
import { Clock, Config, Context, Effect, Layer, Redacted } from 'effect'

/**
 * A profile's photo, from the inline image an agent publishes to the signed
 * link the other person's agent is handed.
 *
 * `profiles.photo_url` holds a reference: either the key of an object in
 * private storage, or an external https URL kept as given. Only this module
 * tells the two apart. Callers keep what `store` returns, and hand that
 * reference back to `release` for the note, to `discard` when the profile
 * goes, and to `read` when the photo route serves bytes. A reference that is
 * not a stored object is passed through or ignored, whichever the verb needs.
 *
 * Built over a `BlobStore`, which is the network boundary: Vercel Blob in
 * production, a map in tests and in the seed script. Signing and image
 * validation run real in both.
 */

/** How long a released photo link stays good. */
export const PHOTO_LINK_TTL_SECONDS = 600

export interface StoredPhoto {
  readonly bytes: Uint8Array
  readonly contentType: string
}

/** The object store under the photos. The one part a test replaces. */
export interface BlobStore {
  readonly put: (key: string, photo: StoredPhoto) => Effect.Effect<void>
  readonly remove: (key: string) => Effect.Effect<void>
  readonly get: (key: string) => Effect.Effect<StoredPhoto | null>
}

export class ProfilePhotos extends Context.Tag('ProfilePhotos')<
  ProfilePhotos,
  {
    /**
     * Keep a photo the contract has already validated. An inline image goes
     * to private storage and comes back as its key; an https URL is its own
     * reference.
     */
    readonly store: (photo: string) => Effect.Effect<string>
    /** A link the other person can open: signed and short-lived when stored. */
    readonly release: (
      reference: string,
      profileId: string
    ) => Effect.Effect<string>
    /** Delete a stored photo. Anything else has nothing to delete. */
    readonly discard: (reference: string) => Effect.Effect<void>
    /** Whether a released link's query string is genuine and unexpired. */
    readonly verifyLink: (
      profileId: string,
      link: URLSearchParams
    ) => Effect.Effect<boolean>
    /** A stored photo's bytes, or null for anything that is not one. */
    readonly read: (reference: string) => Effect.Effect<StoredPhoto | null>
  }
>() {}

const isStored = (reference: string): boolean =>
  /^photos\/[0-9a-f-]+\.(jpeg|png|webp)$/.test(reference)

/**
 * Where the admin console shows a photo: its own photo route for a stored
 * one, which the super-admin session unlocks, an https URL as it is, and
 * nothing for anything else.
 */
export const adminPhotoPath = (
  reference: string | null,
  profileId: string
): string | null =>
  reference === null
    ? null
    : isStored(reference)
      ? `/api/photos/${profileId}`
      : /^https:\/\//i.test(reference)
        ? reference
        : null

/** The bytes of an inline photo, by the contract's rule. Throws on anything else. */
export function decodePhoto(value: string) {
  const match =
    /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match?.[1] || !match[2])
    throw new Error('Photo must be a JPEG, PNG, or WebP image')
  const problem = inlinePhotoProblem(value)
  if (problem !== undefined) throw new Error(problem)
  const type = match[1]
  return {
    bytes: new Uint8Array(Buffer.from(match[2], 'base64')),
    contentType: `image/${type}`,
    extension: type,
  }
}

const signature = (profileId: string, expires: number, secret: string) =>
  createHmac('sha256', secret)
    .update(`swipeless-photo:${profileId}:${expires}`)
    .digest('hex')

export const makeProfilePhotos = (options: {
  readonly blobs: BlobStore
  readonly secret: string
  readonly baseUrl: string
}) => {
  const { blobs, secret, baseUrl } = options

  return ProfilePhotos.of({
    store: (photo) =>
      photo.startsWith('data:')
        ? Effect.gen(function* () {
            // The contract refuses a bad photo before it gets here, so one
            // that does is a defect.
            const decoded = yield* Effect.try(() => decodePhoto(photo)).pipe(
              Effect.orDie
            )
            const key = `photos/${randomUUID()}.${decoded.extension}`
            yield* blobs.put(key, decoded)
            return key
          })
        : Effect.succeed(photo),

    release: (reference, profileId) =>
      isStored(reference)
        ? Effect.map(Clock.currentTimeMillis, (millis) => {
            const expires = Math.floor(millis / 1000) + PHOTO_LINK_TTL_SECONDS
            return `${baseUrl}/api/photos/${profileId}?expires=${expires}&signature=${signature(profileId, expires, secret)}`
          })
        : Effect.succeed(reference),

    discard: (reference) =>
      isStored(reference) ? blobs.remove(reference) : Effect.void,

    verifyLink: (profileId, link) =>
      Effect.map(Clock.currentTimeMillis, (millis) => {
        const now = Math.floor(millis / 1000)
        const expires = Number(link.get('expires'))
        const given = link.get('signature') ?? ''
        if (
          !Number.isSafeInteger(expires) ||
          expires <= now ||
          expires > now + PHOTO_LINK_TTL_SECONDS ||
          !/^[a-f0-9]{64}$/.test(given)
        ) {
          return false
        }
        return timingSafeEqual(
          Buffer.from(given, 'hex'),
          Buffer.from(signature(profileId, expires, secret), 'hex')
        )
      }),

    read: (reference) =>
      isStored(reference) ? blobs.get(reference) : Effect.succeed(null),
  })
}

/** Private Vercel Blob storage. */
export const vercelBlobStore = (token: string): BlobStore => ({
  put: (key, photo) =>
    Effect.promise(() =>
      put(key, Buffer.from(photo.bytes), {
        access: 'private',
        contentType: photo.contentType,
        addRandomSuffix: false,
        token,
      })
    ).pipe(Effect.asVoid),
  remove: (key) => Effect.promise(() => del(key, { token })),
  get: (key) =>
    Effect.promise(async () => {
      const result = await get(key, {
        access: 'private',
        token,
        useCache: false,
      })
      if (result?.statusCode !== 200) return null
      return {
        bytes: new Uint8Array(await new Response(result.stream).arrayBuffer()),
        contentType: result.blob.contentType,
      }
    }),
})

/** Keyless and in memory. */
export const memoryBlobStore = (
  objects: Map<string, StoredPhoto> = new Map()
): BlobStore => ({
  put: (key, photo) =>
    Effect.sync(() => {
      objects.set(key, photo)
    }),
  remove: (key) =>
    Effect.sync(() => {
      objects.delete(key)
    }),
  get: (key) => Effect.sync(() => objects.get(key) ?? null),
})

/**
 * Production photos. The API and the admin app must agree on the signing
 * secret, since one signs the links the other verifies.
 *
 * `PHOTO_LINK_SECRET` keeps link signing apart from storage access, so
 * rotating one does not rotate the other. Until it is set in both Vercel
 * projects, links are signed with the storage token as before.
 */
export const ProfilePhotosLive = Layer.effect(
  ProfilePhotos,
  Effect.gen(function* () {
    const token = Redacted.value(
      yield* Config.redacted('BLOB_READ_WRITE_TOKEN')
    )
    const secret = yield* Config.redacted('PHOTO_LINK_SECRET').pipe(
      Config.withDefault(Redacted.make(token))
    )
    const baseUrl = yield* Config.string('PHOTO_BASE_URL').pipe(
      Config.withDefault('https://swipeless-admin.vercel.app')
    )
    return makeProfilePhotos({
      blobs: vercelBlobStore(token),
      secret: Redacted.value(secret),
      baseUrl,
    })
  })
)
