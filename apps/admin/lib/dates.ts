import { DbLive, PgDrizzle } from '@swipeless/db'
import { adminEvents, profiles, setups } from '@swipeless/db/schema'
import { howWasTheDate, Mailer, MailerLive } from '@swipeless/email'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { Cause, Clock, Effect } from 'effect'
import { isSuperAdmin } from './access.ts'

/**
 * Dates both people said yes to, and the hand-sent follow-up after them.
 *
 * PRODUCT.md, The setup and the date: "After the date, both are asked 'did
 * you enjoy your date?' by SMS or email." Until there is a schedule for it,
 * the super admin presses a button here, and the email asks "how was the
 * date?". Replies come back to the inbox as plain email.
 *
 * Like `review.ts`, plain data and promises out. First names and whether each
 * person gave an email are read for the super admin only.
 */

export interface DatePerson {
  readonly firstName: string
  readonly hasEmail: boolean
}

export interface ConfirmedDate {
  readonly id: string
  readonly venue: { readonly name: string; readonly address: string }
  /** ISO-8601, the suggested date time. */
  readonly time: string
  /** ISO-8601, or null while the follow-up has not gone out. */
  readonly followUpSentAt: string | null
  /** Present for the super admin only. */
  readonly people?: readonly [DatePerson, DatePerson]
}

export interface ConfirmedDates {
  readonly dates: ReadonlyArray<ConfirmedDate>
  /** Whether this viewer may send the follow-up. */
  readonly canSend: boolean
}

export type ConfirmedDatesResult =
  | { readonly _tag: 'Loaded'; readonly confirmed: ConfirmedDates }
  | { readonly _tag: 'Unavailable'; readonly reason: string }

export type FollowUpOutcome =
  | { readonly _tag: 'Sent'; readonly emailed: number }
  /** Not the super admin. Nothing was read or written. */
  | { readonly _tag: 'Forbidden' }
  /** Gone, not confirmed, or already followed up. Nothing was written. */
  | { readonly _tag: 'NotSendable' }
  /** Neither person gave an email. Nothing was written. */
  | { readonly _tag: 'NoEmail' }
  | { readonly _tag: 'Unavailable'; readonly reason: string }

export const CONFIRMED_DATES_SIZE = 50

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Confirmed setups, latest date first. A confirmed setup never expires. */
export const confirmedDates = (verifiedEmail: string | null | undefined) =>
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle
    const superAdmin = isSuperAdmin(verifiedEmail)
    const rows = yield* db
      .select({
        id: setups.id,
        profileAId: setups.profileAId,
        profileBId: setups.profileBId,
        date: setups.date,
        followUpSentAt: setups.followUpSentAt,
      })
      .from(setups)
      .where(eq(setups.status, 'confirmed'))
      .orderBy(desc(sql`(${setups.date}->>'time')::timestamptz`))
      .limit(CONFIRMED_DATES_SIZE)

    // Ordinary admins never run this query, so the fields never reach them.
    const people =
      superAdmin && rows.length > 0
        ? yield* db
            .select({
              id: profiles.id,
              firstName: profiles.firstName,
              hasEmail: sql<boolean>`${profiles.email} is not null and ${profiles.email} <> ''`,
            })
            .from(profiles)
            .where(
              inArray(
                profiles.id,
                rows.flatMap((row) => [row.profileAId, row.profileBId])
              )
            )
        : []
    const personById = new Map(
      people.map(({ id, ...person }) => [id, person satisfies DatePerson])
    )

    return {
      dates: rows.map((row): ConfirmedDate => {
        const a = personById.get(row.profileAId)
        const b = personById.get(row.profileBId)
        return {
          id: row.id,
          venue: row.date.venue,
          time: row.date.time,
          followUpSentAt: row.followUpSentAt?.toISOString() ?? null,
          ...(a && b ? { people: [a, b] as const } : {}),
        }
      }),
      canSend: superAdmin,
    } satisfies ConfirmedDates
  })

/**
 * Email both people "how was the date?", for the super admin only.
 *
 * The stamp is a guarded update, so only a confirmed setup that has not been
 * followed up is touched and two tabs send one round. The stamp lands before
 * the emails go out: a lost email is better than a second one.
 */
export const followUp = (
  setupId: string,
  verifiedEmail: string | null | undefined
) =>
  Effect.gen(function* () {
    if (!isSuperAdmin(verifiedEmail)) return { _tag: 'Forbidden' } as const
    if (!UUID.test(setupId)) return { _tag: 'NotSendable' } as const

    const db = yield* PgDrizzle.PgDrizzle
    const mailer = yield* Mailer
    const at = new Date(yield* Clock.currentTimeMillis)

    const [row] = yield* db
      .select({ profileAId: setups.profileAId, profileBId: setups.profileBId })
      .from(setups)
      .where(eq(setups.id, setupId))
    if (row === undefined) return { _tag: 'NotSendable' } as const
    const people = yield* db
      .select({
        id: profiles.id,
        firstName: profiles.firstName,
        email: profiles.email,
      })
      .from(profiles)
      .where(inArray(profiles.id, [row.profileAId, row.profileBId]))
    const a = people.find((person) => person.id === row.profileAId)
    const b = people.find((person) => person.id === row.profileBId)
    if (a === undefined || b === undefined) {
      return { _tag: 'NotSendable' } as const
    }
    if (!a.email && !b.email) return { _tag: 'NoEmail' } as const

    const stamped = yield* db
      .update(setups)
      .set({ followUpSentAt: at })
      .where(
        and(
          eq(setups.id, setupId),
          eq(setups.status, 'confirmed'),
          isNull(setups.followUpSentAt)
        )
      )
      .returning({ id: setups.id })
    if (stamped.length === 0) return { _tag: 'NotSendable' } as const

    const pairs = [
      [a, b],
      [b, a],
    ] as const
    let emailed = 0
    for (const [self, other] of pairs) {
      if (!self.email) continue
      yield* mailer.send(
        howWasTheDate(self.email, self.firstName, other.firstName)
      )
      emailed += 1
    }
    yield* db.insert(adminEvents).values({
      kind: 'setup.follow_up_sent',
      payload: { setupId, emailed },
      createdAt: at,
    })
    return { _tag: 'Sent', emailed } as const
  })

const unavailable = (cause: Cause.Cause<unknown>) =>
  Effect.succeed({ _tag: 'Unavailable', reason: Cause.pretty(cause) } as const)

/** Never throws, for the same reasons as `loadDashboard`. */
export const loadConfirmedDates = (
  verifiedEmail: string | null | undefined
): Promise<ConfirmedDatesResult> =>
  Effect.runPromise(
    confirmedDates(verifiedEmail).pipe(
      Effect.map((confirmed) => ({ _tag: 'Loaded', confirmed }) as const),
      Effect.provide(DbLive),
      Effect.catchAllCause(unavailable)
    )
  )

/** Pass only the email from the server-verified session. Never throws. */
export const sendFollowUp = (
  setupId: string,
  verifiedEmail: string | null | undefined
): Promise<FollowUpOutcome> =>
  // Refused before the layer is built, so a non-super admin never connects.
  isSuperAdmin(verifiedEmail)
    ? Effect.runPromise(
        followUp(setupId, verifiedEmail).pipe(
          Effect.provide(MailerLive),
          Effect.provide(DbLive),
          Effect.catchAllCause(unavailable)
        )
      )
    : Promise.resolve({ _tag: 'Forbidden' })
