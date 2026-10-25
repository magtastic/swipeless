import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { inlinePhotoProblem } from '@swipeless/shared'
import { del, get, put } from '@vercel/blob'
import { Clock, Config, Context, Effect, Layer, Redacted } from 'effect'

export const PHOTO_LINK_TTL_SECONDS = 600
export const isPhotoKey = (value: string): boolean =>
  /^photos\/[0-9a-f-]+\.(jpeg|png|webp)$/.test(value)

export function decodePhoto(value: string) {
  const match =
    /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match?.[1] || !match[2])
    throw new Error('Photo must be a JPEG, PNG, or WebP image')
  // The contract refuses these first; this is the same rule, kept at the
  // storage boundary so nothing else can upload a file the contract would not.
  const problem = inlinePhotoProblem(value)
  if (problem !== undefined) throw new Error(problem)
  const type = match[1]
  return {
    bytes: Buffer.from(match[2], 'base64'),
    contentType: `image/${type}`,
    extension: type,
  }
}

export class PhotoStorage extends Context.Tag('PhotoStorage')<
  PhotoStorage,
  {
    readonly upload: (dataUri: string) => Effect.Effect<string>
    readonly remove: (key: string) => Effect.Effect<void>
    readonly read: (
      key: string
    ) => Effect.Effect<{ bytes: Uint8Array; contentType: string } | null>
  }
>() {}

export const PhotoStorageLive = Layer.effect(
  PhotoStorage,
  Effect.gen(function* () {
    const token = Redacted.value(
      yield* Config.redacted('BLOB_READ_WRITE_TOKEN')
    )
    return PhotoStorage.of({
      upload: (value) =>
        Effect.promise(async () => {
          const photo = decodePhoto(value)
          const result = await put(
            `photos/${randomUUID()}.${photo.extension}`,
            photo.bytes,
            {
              access: 'private',
              contentType: photo.contentType,
              addRandomSuffix: false,
              token,
            }
          )
          return result.pathname
        }),
      remove: (key) =>
        isPhotoKey(key)
          ? Effect.promise(() => del(key, { token }))
          : Effect.void,
      read: (key) =>
        Effect.promise(async () => {
          if (!isPhotoKey(key)) return null
          const result = await get(key, {
            access: 'private',
            token,
            useCache: false,
          })
          if (result?.statusCode !== 200) return null
          return {
            bytes: new Uint8Array(
              await new Response(result.stream).arrayBuffer()
            ),
            contentType: result.blob.contentType,
          }
        }),
    })
  })
)

export function signPhoto(
  profileId: string,
  expires: number,
  secret: string
): string {
  return createHmac('sha256', secret)
    .update(`swipeless-photo:${profileId}:${expires}`)
    .digest('hex')
}
export function validPhotoSignature(
  profileId: string,
  expires: number,
  signature: string,
  secret: string,
  now: number
): boolean {
  if (
    !Number.isSafeInteger(expires) ||
    expires <= now ||
    expires > now + PHOTO_LINK_TTL_SECONDS ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return false
  return timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(signPhoto(profileId, expires, secret), 'hex')
  )
}

export class PhotoLinks extends Context.Tag('PhotoLinks')<
  PhotoLinks,
  {
    readonly url: (
      reference: string,
      profileId: string
    ) => Effect.Effect<string>
  }
>() {}
export const photoLinks = (secret: string, baseUrl: string) =>
  PhotoLinks.of({
    url: (reference, profileId) =>
      isPhotoKey(reference)
        ? Effect.map(Clock.currentTimeMillis, (at) => {
            const expires = Math.floor(at / 1000) + PHOTO_LINK_TTL_SECONDS
            return `${baseUrl}/api/photos/${profileId}?expires=${expires}&signature=${signPhoto(profileId, expires, secret)}`
          })
        : Effect.succeed(reference),
  })
export const PhotoLinksLive = Layer.effect(
  PhotoLinks,
  Effect.gen(function* () {
    const token = Redacted.value(
      yield* Config.redacted('BLOB_READ_WRITE_TOKEN')
    )
    const baseUrl = yield* Config.string('PHOTO_BASE_URL').pipe(
      Config.withDefault('https://swipeless-admin.vercel.app')
    )
    return photoLinks(token, baseUrl)
  })
)
