import { GENDERS, REVIEW_STATUSES } from '@swipeless/shared'
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'

/** Dimensionality of the brief embedding (OpenAI text-embedding-3-small). */
export const EMBEDDING_DIMENSIONS = 1536

export const genderEnum = pgEnum('gender', GENDERS)

export const reviewStatusEnum = pgEnum('review_status', REVIEW_STATUSES)

export const profiles = pgTable(
  'profiles',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** SHA-256 of the bearer token. The token itself is never stored. */
    tokenHash: text().notNull().unique(),

    // Core
    age: integer().notNull(),
    gender: genderEnum().notNull(),
    interestedIn: genderEnum().array().notNull(),
    city: text().notNull(),
    country: text().notNull(),
    radiusKm: integer().notNull().default(25),
    availability: text().notNull(),

    // Brief
    brief: text().notNull(),
    embedding: vector({ dimensions: EMBEDDING_DIMENSIONS }),

    // Shown in the note, to the one person a date is with
    firstName: text().notNull(),
    /**
     * Required by the contract. Nullable here only so profiles published
     * before photos were required still load.
     */
    photoUrl: text(),

    // Private layer, released only when both say yes
    phone: text().notNull(),

    /** A person checks every profile before it goes live. Only approved ones match. */
    reviewStatus: reviewStatusEnum().notNull().default('pending'),
    reviewedAt: timestamp({ withTimezone: true }),

    email: text(),
    standingInstructions: text(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Bumped on every authenticated call; profiles expire 90d after this. */
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('profiles_embedding_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops')
    ),
    index('profiles_last_seen_at_idx').on(table.lastSeenAt),
    index('profiles_location_idx').on(table.country, table.city),
    index('profiles_review_status_idx').on(table.reviewStatus),
  ]
)

export type ProfileRow = typeof profiles.$inferSelect
export type NewProfileRow = typeof profiles.$inferInsert
