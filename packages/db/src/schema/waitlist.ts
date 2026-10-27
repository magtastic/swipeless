import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * People who asked on swipeless.me to hear when the closed beta opens. Only
 * an email, lowercased, so asking twice is one row. Nothing links it to a
 * profile.
 */
export const waitlist = pgTable('waitlist', {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

export type WaitlistRow = typeof waitlist.$inferSelect
