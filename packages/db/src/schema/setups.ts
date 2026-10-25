import { type DateSuggestion, SETUP_STATUSES } from '@swipeless/shared'
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { profiles } from './profiles.ts'

export const setupStatusEnum = pgEnum('setup_status', SETUP_STATUSES)

/**
 * A pair. `profileAId < profileBId` always, so a pair has exactly one row
 * regardless of whose agent picked first.
 *
 * An agent's pick creates the row with a suggested date and stamps that side's
 * `interestedAAt` / `interestedBAt`. A `suggested` row is visible only to the
 * side that picked; one human's yes makes it `requested` and visible to both.
 * PRODUCT.md: interest "stays hidden until both say yes".
 */
export const setups = pgTable(
  'setups',
  {
    id: uuid().primaryKey().defaultRandom(),
    profileAId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    profileBId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    status: setupStatusEnum().notNull().default('suggested'),
    /** When each side's agent picked the other. Null means it has not. */
    interestedAAt: timestamp({ withTimezone: true }),
    interestedBAt: timestamp({ withTimezone: true }),
    /** The date swipeless suggested at the pick: a public place and a time. */
    date: jsonb().$type<typeof DateSuggestion.Encoded>().notNull(),
    /** Each human's yes. */
    confirmedA: boolean().notNull().default(false),
    confirmedB: boolean().notNull().default(false),
    /** When the admin site sent both "how was the date?". Null means not yet. */
    followUpSentAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [
    unique('setups_pair_key').on(table.profileAId, table.profileBId),
    index('setups_profile_a_id_idx').on(table.profileAId),
    index('setups_profile_b_id_idx').on(table.profileBId),
    index('setups_status_idx').on(table.status),
    check(
      'setups_ordered_pair',
      sql`${table.profileAId} < ${table.profileBId}`
    ),
  ]
)

export type SetupRow = typeof setups.$inferSelect
export type NewSetupRow = typeof setups.$inferInsert
