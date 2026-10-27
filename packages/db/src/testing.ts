import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqlClient, type SqlError } from '@effect/sql'
import * as PgDrizzle from '@effect/sql-drizzle/Pg'
import { PgClient } from '@effect/sql-pg'
import { Config, Effect, Layer } from 'effect'

/**
 * Test-only database support. Imported as `@swipeless/db/testing`.
 *
 * Module tests run against a real Postgres rather than a mock: the hard
 * filters, the pgvector ordering and the cascade on delete are the parts most
 * worth testing, and none of them survive being faked.
 */

/**
 * Whether a test database is configured. Suites gate on this and skip loudly
 * when it is unset, so `bun test` stays runnable without Docker while
 * `bun run test:db` covers the real thing.
 */
export const hasTestDb = (process.env.TEST_DATABASE_URL ?? '') !== ''

const TestPgLive = PgClient.layerConfig({
  url: Config.redacted('TEST_DATABASE_URL'),
})

/** Same shape as DbLive, pointed at TEST_DATABASE_URL. */
export const TestDbLive = PgDrizzle.layerWithConfig({
  casing: 'snake_case',
}).pipe(Layer.provideMerge(TestPgLive))

const migrationsDir = fileURLToPath(new URL('../drizzle/', import.meta.url))

type Journal = {
  readonly entries: ReadonlyArray<{ readonly tag: string }>
}

/** Every statement of every migration, in journal order. */
const migrationStatements = (): ReadonlyArray<string> => {
  const journal = JSON.parse(
    readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8')
  ) as Journal

  return journal.entries.flatMap((entry) =>
    readFileSync(join(migrationsDir, `${entry.tag}.sql`), 'utf8')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0)
  )
}

/**
 * Postgres codes for "this object is already there". drizzle-kit's SQL is not
 * written with IF NOT EXISTS, so an already-migrated database is recognised by
 * the error rather than by a migrations table.
 */
const ALREADY_EXISTS = new Set([
  '42P06', // duplicate_schema
  '42P07', // duplicate_table
  '42701', // duplicate_column
  '42710', // duplicate_object (types, constraints, indexes)
])

const isAlreadyExists = (error: SqlError.SqlError): boolean => {
  const cause: unknown = error.cause
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    typeof cause.code === 'string' &&
    ALREADY_EXISTS.has(cause.code)
  )
}

/**
 * Apply every migration. Idempotent: statements that describe something
 * already present are skipped, so this can run before each suite.
 */
export const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  for (const statement of migrationStatements()) {
    yield* sql
      .unsafe(statement)
      .pipe(Effect.catchIf(isAlreadyExists, () => Effect.void))
  }
})

/** Empty every table. Run before each test that touches the database. */
export const truncateAll = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`truncate table setups, profiles, admin_events, waitlist cascade`
})
