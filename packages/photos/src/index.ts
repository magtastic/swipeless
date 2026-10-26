import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  BadPhoto,
  inlinePhotoProblem,
  type UploadedFile,
} from '@swipeless/shared'
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

/**
 * The largest photo an upload may be. Above the 1 MiB inline cap, because a
 * photo straight off a phone is usually bigger, and below the 4.5 MB a Vercel
 * Function can answer with, since the photo routes serve it back.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024

/**
 * Fetches at most `limit` bytes from `url`: the bytes, undefined when there
 * are more, or a failure. The network edge under uploads, and the part a test
 * replaces.
 */
export type Download = (
  url: URL,
  limit: number
) => Effect.Effect<Uint8Array | undefined, unknown>

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
    /**
     * Fetch a photo uploaded in ChatGPT and keep it in private storage,
     * returning its key. ChatGPT only (docs/decisions.md, 2026-10-26).
     */
    readonly storeUpload: (
      file: UploadedFile | string
    ) => Effect.Effect<string, BadPhoto>
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

/**
 * Hosts ChatGPT serves uploads from. Only these are fetched, so a publish can
 * never make swipeless request an arbitrary or internal address.
 */
const UPLOAD_HOSTS = ['oaiusercontent.com', 'chatgpt.com', 'openai.com']

const isUploadHost = (url: URL): boolean =>
  url.protocol === 'https:' &&
  url.port === '' &&
  UPLOAD_HOSTS.some(
    (host) => url.hostname === host || url.hostname.endsWith(`.${host}`)
  )

/** The image type the bytes' own signature says, if it is one we keep. */
const imageType = (bytes: Uint8Array): 'jpeg' | 'png' | 'webp' | undefined => {
  const at = (offset: number, expected: ReadonlyArray<number>) =>
    expected.every((byte, index) => bytes[offset + index] === byte)
  if (at(0, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50]))
    return 'webp'
  return undefined
}

const badPhoto = (message: string) => new BadPhoto({ message })

/** Reads at most `limit` bytes, or undefined if the body is longer. */
export const readCapped = async (response: Response, limit: number) => {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > limit || response.body === null) return undefined
  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** The real download: https only, ten seconds, and never past `limit`. */
export const fetchDownload: Download = (url, limit) =>
  Effect.tryPromise(async () => {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok || !response.url.startsWith('https://')) {
      throw new Error(`upload answered ${response.status} at ${response.url}`)
    }
    return readCapped(response, limit)
  })

const signature = (profileId: string, expires: number, secret: string) =>
  createHmac('sha256', secret)
    .update(`swipeless-photo:${profileId}:${expires}`)
    .digest('hex')

export const makeProfilePhotos = (options: {
  readonly blobs: BlobStore
  readonly download: Download
  readonly secret: string
  readonly baseUrl: string
}) => {
  const { blobs, download, secret, baseUrl } = options

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

    storeUpload: (file) =>
      Effect.gen(function* () {
        if (typeof file === 'string') {
          // ChatGPT on phones sometimes sends "chat_upload" and no file.
          return yield* badPhoto(
            'The photo arrived without the file, which ChatGPT on phones sometimes does. Ask them for a link to a photo instead, or to drop it in again from ChatGPT on the web or desktop.'
          )
        }
        const url = URL.canParse(file.download_url)
          ? new URL(file.download_url)
          : undefined
        if (url === undefined || !isUploadHost(url)) {
          yield* Effect.logWarning(
            'Refused a photo upload from this host'
          ).pipe(Effect.annotateLogs('host', url?.host ?? 'unparseable'))
          return yield* badPhoto(
            'swipeless only fetches photos uploaded to ChatGPT. Ask them for a link to a photo instead.'
          )
        }
        const bytes = yield* download(url, MAX_UPLOAD_BYTES).pipe(
          Effect.tapError((error) =>
            Effect.logWarning(
              'A photo upload could not be fetched',
              String(error)
            )
          ),
          Effect.mapError(() =>
            badPhoto(
              'swipeless could not fetch that photo. Ask them to drop it into the chat again, or for a link to it.'
            )
          )
        )
        if (bytes === undefined) {
          return yield* badPhoto(
            'That photo is over 4 MB. Ask them for a smaller one.'
          )
        }
        const type = imageType(bytes)
        if (type === undefined) {
          return yield* badPhoto(
            'That file is not a JPEG, PNG or WebP photo. Ask them for one that is.'
          )
        }
        const key = `photos/${randomUUID()}.${type}`
        yield* blobs.put(key, { bytes, contentType: `image/${type}` })
        return key
      }),

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
      Config.withDefault('https://admin.swipeless.me')
    )
    return makeProfilePhotos({
      blobs: vercelBlobStore(token),
      download: fetchDownload,
      secret: Redacted.value(secret),
      baseUrl,
    })
  })
)
