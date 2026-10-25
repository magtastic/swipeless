import { createHash } from 'node:crypto'
import { DbLive, PgDrizzle } from '@swipeless/db'
import { profiles } from '@swipeless/db/schema'
import {
  decodePhoto,
  ProfilePhotos,
  ProfilePhotosLive,
} from '@swipeless/photos'
import { and, eq, like, sql } from 'drizzle-orm'
import { Effect } from 'effect'

/** Idempotent: verify each private upload before replacing its inline database value. */
const migration = Effect.gen(function* () {
  const db = yield* PgDrizzle.PgDrizzle
  const storage = yield* ProfilePhotos
  let migrated = 0
  let bytesMoved = 0
  for (;;) {
    const rows = yield* db
      .select({ id: profiles.id, photo: profiles.photoUrl })
      .from(profiles)
      .where(like(profiles.photoUrl, 'data:image/%'))
      .limit(1)
    const row = rows[0]
    if (!row?.photo) break
    const original = decodePhoto(row.photo)
    const key = yield* storage.store(row.photo)
    const uploaded = yield* storage.read(key)
    const hash = (bytes: Uint8Array) =>
      createHash('sha256').update(bytes).digest('hex')
    if (!uploaded || hash(uploaded.bytes) !== hash(original.bytes)) {
      yield* storage.discard(key)
      return yield* Effect.dieMessage(
        'Uploaded photo verification failed; database photo retained'
      )
    }
    const changed = yield* db
      .update(profiles)
      .set({ photoUrl: key })
      .where(and(eq(profiles.id, row.id), eq(profiles.photoUrl, row.photo)))
      .returning({ id: profiles.id })
    if (changed.length === 0) yield* storage.discard(key)
    else {
      migrated++
      bytesMoved += original.bytes.length
    }
  }
  const [summary] = yield* db
    .select({
      inline: sql<number>`count(*) filter (where ${profiles.photoUrl} like 'data:%')::int`,
      stored: sql<number>`count(*) filter (where ${profiles.photoUrl} like 'photos/%')::int`,
      external: sql<number>`count(*) filter (where ${profiles.photoUrl} like 'https://%')::int`,
    })
    .from(profiles)
  console.log(JSON.stringify({ migrated, bytesMoved, ...summary }))
})

await Effect.runPromise(
  migration.pipe(Effect.provide(DbLive), Effect.provide(ProfilePhotosLive))
)
