import Image from 'next/image'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { auth, signOut } from '../auth.ts'
import { isSuperAdmin } from '../lib/access.ts'
import {
  type AdminEvent,
  type Dashboard,
  loadDashboard,
  type ProfileOverview,
  type SetupCount,
} from '../lib/dashboard.ts'
import {
  type ConfirmedDate,
  type ConfirmedDates,
  loadConfirmedDates,
} from '../lib/dates.ts'
import {
  loadReviewQueue,
  type PendingProfile,
  type ReviewQueue,
} from '../lib/review.ts'
import { followUpDate } from './date-actions.ts'
import { approveProfile, rejectProfile } from './review-actions.ts'

/** Every read is per-request, and `next build` runs without a database. */
export const dynamic = 'force-dynamic'

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        {label}
      </div>
    </div>
  )
}

function Profiles({ counts }: { counts: Dashboard['profiles'] }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-500">
        Profiles
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="live" value={counts.live} />
        <Stat label="expiring in 7d" value={counts.expiringSoon} />
        <Stat label="expired" value={counts.expired} />
        <Stat label="total rows" value={counts.total} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="waiting for review" value={counts.review.pending} />
        <Stat label="approved" value={counts.review.approved} />
        <Stat label="rejected" value={counts.review.rejected} />
      </div>
    </section>
  )
}

/** Stored photos come through `/api/photos/`; anything else must be https. */
const displayable = (source: string | null) =>
  source &&
  (source.startsWith('/api/photos/') ||
    /^https:\/\//i.test(source) ||
    /^data:image\/(jpeg|png|webp|gif);base64,/i.test(source))
    ? source
    : null

function Photo({
  source,
  firstName,
  size,
}: {
  source: string | null
  firstName: string
  size: number
}) {
  const imageSource = displayable(source)
  return imageSource ? (
    <Image
      src={imageSource}
      alt={`Photo of ${firstName}`}
      width={size}
      height={size}
      unoptimized
      referrerPolicy="no-referrer"
      className="h-auto max-h-80 w-auto max-w-full rounded-lg object-contain"
    />
  ) : (
    <p className="text-sm text-soft">
      {source ? 'Photo format cannot be displayed.' : 'No photo uploaded.'}
    </p>
  )
}

function PendingCard({
  profile,
  canDecide,
}: {
  profile: PendingProfile
  canDecide: boolean
}) {
  const waiting = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(profile.createdAt))
  return (
    <li className="flex flex-col gap-4 rounded-xl border border-rule-strong bg-sheet p-5 sm:flex-row">
      {profile.note && (
        <div className="shrink-0 sm:w-48">
          <Photo
            source={profile.note.photoUrl}
            firstName={profile.note.firstName}
            size={192}
          />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div>
          <h3 className="text-lg font-semibold">
            {profile.note ? (
              <span className="font-hand text-3xl font-normal">
                {profile.note.firstName},{' '}
              </span>
            ) : null}
            {profile.age} · {profile.gender.replaceAll('_', ' ')} ·{' '}
            {profile.city}, {profile.country}
          </h3>
          <p className="mt-1 text-sm text-soft">
            Published {waiting} (UTC) ·{' '}
            <code className="break-all text-xs">{profile.id}</code>
          </p>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm leading-7">
          {profile.brief}
        </p>
        {canDecide && (
          <div className="flex gap-3">
            <form action={approveProfile}>
              <input type="hidden" name="profileId" value={profile.id} />
              <button
                type="submit"
                className="rounded-md bg-hi px-4 py-2 text-sm font-semibold text-hi-ink hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                Approve
              </button>
            </form>
            <form action={rejectProfile}>
              <input type="hidden" name="profileId" value={profile.id} />
              <button
                type="submit"
                className="rounded-md border border-red px-4 py-2 text-sm font-semibold text-red hover:bg-red/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                Reject
              </button>
            </form>
          </div>
        )}
      </div>
    </li>
  )
}

function Review({ queue }: { queue: ReviewQueue }) {
  return (
    <section className="flex flex-col gap-4" aria-labelledby="review-queue">
      <div>
        <h2 id="review-queue" className="text-lg font-semibold">
          Review queue
        </h2>
        <p className="mt-1 text-sm text-soft">
          Oldest first. Nobody is matched until approved: check the photo is a
          real person over 18 and the brief is about them.
          {!queue.canDecide && ' Only the super admin can approve or reject.'}
        </p>
      </div>
      {queue.pending.length === 0 ? (
        <p className="font-hand text-2xl text-ink">
          All caught up. Nobody waiting.
        </p>
      ) : (
        <ol className="flex flex-col gap-4">
          {queue.pending.map((profile) => (
            <PendingCard
              key={profile.id}
              profile={profile}
              canDecide={queue.canDecide}
            />
          ))}
        </ol>
      )}
      {queue.hasMore && (
        <p className="text-sm text-soft">
          More are waiting. Decide these and the next ones appear.
        </p>
      )}
    </section>
  )
}

const dateTime = (value: string) =>
  new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Atlantic/Reykjavik',
  }).format(new Date(value))

function DateRow({
  date,
  canSend,
  now,
}: {
  date: ConfirmedDate
  canSend: boolean
  now: number
}) {
  const past = Date.parse(date.time) <= now
  const anyEmail = date.people?.some((person) => person.hasEmail) ?? false
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-rule-strong bg-sheet p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-semibold">
          {date.people ? (
            <span className="font-hand text-3xl font-normal">
              {date.people.map((person) => person.firstName).join(' & ')}
            </span>
          ) : (
            <code className="break-all text-xs">{date.id}</code>
          )}
        </p>
        <p className="mt-1 text-sm">
          {date.venue.name}, {date.venue.address}
        </p>
        <p className="mt-1 text-sm text-soft">
          {dateTime(date.time)} · {past ? 'past' : 'upcoming'}
          {date.people &&
            ` · email: ${date.people
              .map(
                (person) =>
                  `${person.firstName} ${person.hasEmail ? 'yes' : 'no'}`
              )
              .join(', ')}`}
        </p>
      </div>
      {date.followUpSentAt ? (
        <p className="shrink-0 text-sm text-soft">
          Asked {dateTime(date.followUpSentAt)}
        </p>
      ) : canSend ? (
        anyEmail ? (
          <form action={followUpDate} className="shrink-0">
            <input type="hidden" name="setupId" value={date.id} />
            <button
              type="submit"
              className="rounded-md bg-hi px-4 py-2 text-sm font-semibold text-hi-ink hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              Ask how the date was
            </button>
          </form>
        ) : (
          <p className="shrink-0 text-sm text-soft">No email on file</p>
        )
      ) : null}
    </li>
  )
}

function Dates({ confirmed, now }: { confirmed: ConfirmedDates; now: number }) {
  return (
    <section className="flex flex-col gap-4" aria-labelledby="confirmed-dates">
      <div>
        <h2 id="confirmed-dates" className="text-lg font-semibold">
          Confirmed dates
        </h2>
        <p className="mt-1 text-sm text-soft">
          Both said yes. Latest date first. After the date, ask both how it
          went: one email each, replies come to the inbox.
          {!confirmed.canSend &&
            ' Only the super admin can send the follow-up.'}
        </p>
      </div>
      {confirmed.dates.length === 0 ? (
        <p className="font-hand text-2xl text-ink">No dates yet.</p>
      ) : (
        <ol className="flex flex-col gap-4">
          {confirmed.dates.map((date) => (
            <DateRow
              key={date.id}
              date={date}
              canSend={confirmed.canSend}
              now={now}
            />
          ))}
        </ol>
      )}
    </section>
  )
}

function PrivateDetails({
  note,
  details,
}: {
  note: NonNullable<ProfileOverview['note']>
  details: NonNullable<ProfileOverview['privateDetails']>
}) {
  return (
    <section className="space-y-4 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
      <h3 className="font-medium">
        Note and private details{' '}
        <span className="ml-2 text-xs font-normal text-amber-800 dark:text-amber-200">
          Super admin only
        </span>
      </h3>
      <Photo source={note.photoUrl} firstName={note.firstName} size={320} />
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-neutral-500">First name</dt>
          <dd className="mt-1">{note.firstName}</dd>
        </div>
        <div>
          <dt className="text-neutral-500">Phone</dt>
          <dd className="mt-1">{details.phone}</dd>
        </div>
        <div>
          <dt className="text-neutral-500">Email</dt>
          <dd className="mt-1 break-all">{details.email || 'Not provided'}</dd>
        </div>
        <div>
          <dt className="text-neutral-500">Standing instructions</dt>
          <dd className="mt-1 whitespace-pre-wrap break-words">
            {details.standingInstructions || 'None'}
          </dd>
        </div>
      </dl>
    </section>
  )
}

function ProfileOverviews({
  profiles,
  page,
  hasMore,
}: {
  profiles: ReadonlyArray<ProfileOverview>
  page: number
  hasMore: boolean
}) {
  const label = (value: string) => value.replaceAll('_', ' ')
  const date = (value: string) =>
    new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium',
      timeZone: 'UTC',
    }).format(new Date(value))
  return (
    <section
      className="flex flex-col gap-4"
      aria-labelledby="profile-overviews"
    >
      <div>
        <h2 id="profile-overviews" className="text-lg font-semibold">
          Published profiles
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Newest first. Expand a profile to read its brief.
        </p>
      </div>
      {profiles.length === 0 ? (
        <p className="text-sm text-neutral-500">
          {page === 1
            ? 'No profiles published yet.'
            : 'No profiles on this page.'}
        </p>
      ) : (
        profiles.map((profile) => (
          <details
            key={profile.id}
            className="group rounded-xl border border-neutral-200 dark:border-neutral-800"
          >
            <summary className="cursor-pointer rounded-xl p-5 focus-visible:outline-2 focus-visible:outline-offset-2">
              <span className="ml-2 font-medium">
                {profile.age} · {label(profile.gender)} · {profile.city},{' '}
                {profile.country}
              </span>
              <span
                className={`ml-3 rounded-full px-2 py-1 text-xs ${profile.expired ? 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300' : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'}`}
              >
                {profile.expired ? 'Expired' : 'Live'}
              </span>
              <span className="ml-2 rounded-full border border-rule-strong px-2 py-1 text-xs text-soft">
                {profile.reviewStatus}
              </span>
              <span className="mt-2 block text-sm text-neutral-500">
                Interested in {profile.interestedIn.map(label).join(', ')} ·
                Published {date(profile.createdAt)}
              </span>
            </summary>
            <div className="space-y-5 border-t border-neutral-200 p-5 dark:border-neutral-800">
              <dl className="grid gap-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-neutral-500">Availability</dt>
                  <dd className="mt-1">{profile.availability}</dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Date radius</dt>
                  <dd className="mt-1">{profile.radiusKm} km</dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Last check-in</dt>
                  <dd className="mt-1">{date(profile.lastSeenAt)} (UTC)</dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Profile ID</dt>
                  <dd className="mt-1 break-all font-mono text-xs">
                    {profile.id}
                  </dd>
                </div>
              </dl>
              {profile.note && profile.privateDetails && (
                <PrivateDetails
                  note={profile.note}
                  details={profile.privateDetails}
                />
              )}
              <div>
                <h3 className="mb-2 font-medium">Brief</h3>
                <p className="whitespace-pre-wrap break-words text-sm leading-7">
                  {profile.brief}
                </p>
              </div>
            </div>
          </details>
        ))
      )}
      {(page > 1 || hasMore) && (
        <nav
          aria-label="Profile pages"
          className="flex items-center justify-between text-sm"
        >
          {page > 1 ? (
            <Link
              className="underline underline-offset-4"
              href={`/?page=${page - 1}#profile-overviews`}
            >
              Newer profiles
            </Link>
          ) : (
            <span />
          )}
          <span className="text-neutral-500">Page {page}</span>
          {hasMore ? (
            <Link
              className="underline underline-offset-4"
              href={`/?page=${page + 1}#profile-overviews`}
            >
              Older profiles
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </section>
  )
}

function Setups({ counts }: { counts: ReadonlyArray<SetupCount> }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-500">
        Setups by status
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {counts.map((entry) => (
          <Stat
            key={entry.status}
            label={entry.status.replace('_', ' ')}
            value={entry.count}
          />
        ))}
      </div>
    </section>
  )
}

function Events({ events }: { events: ReadonlyArray<AdminEvent> }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-500">
        Recent events
      </h2>
      {events.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Nothing recorded yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-200 text-neutral-500 dark:border-neutral-800 dark:text-neutral-500">
              <tr>
                <th className="px-4 py-2 font-medium">time</th>
                <th className="px-4 py-2 font-medium">kind</th>
                <th className="px-4 py-2 font-medium">profile</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr
                  key={event.id}
                  className="border-t border-neutral-100 dark:border-neutral-900"
                >
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-neutral-600 dark:text-neutral-400">
                    {event.createdAt}
                  </td>
                  <td className="px-4 py-2">
                    <code>{event.kind}</code>
                  </td>
                  <td className="px-4 py-2 text-neutral-600 dark:text-neutral-400">
                    <code>{event.profileId ?? '—'}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[] }>
}) {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const query = await searchParams
  const requestedPage = typeof query.page === 'string' ? Number(query.page) : 1
  const page =
    Number.isSafeInteger(requestedPage) &&
    requestedPage > 0 &&
    requestedPage <= 100000
      ? requestedPage
      : 1
  const [result, review, dates] = await Promise.all([
    loadDashboard(page, session.user.email),
    loadReviewQueue(session.user.email),
    loadConfirmedDates(session.user.email),
  ])
  const now = Date.now()

  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-10 px-6 py-12">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">
          swipeless admin
        </h1>
        <div className="flex items-baseline gap-3 text-sm text-neutral-600 dark:text-neutral-400">
          <span>{session.user.email}</span>
          {isSuperAdmin(session.user.email) && (
            <span className="rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-900">
              Super admin · testing
            </span>
          )}
          <form
            action={async () => {
              'use server'
              await signOut({ redirectTo: '/signin' })
            }}
          >
            <button
              type="submit"
              className="underline underline-offset-4 hover:no-underline"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      {result._tag === 'Unavailable' ? (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <p className="font-medium">The database is not answering</p>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs">
            {result.reason}
          </pre>
        </div>
      ) : (
        <>
          {review._tag === 'Loaded' ? (
            <Review queue={review.queue} />
          ) : (
            <p className="text-sm text-red">
              The review queue could not load: {review.reason}
            </p>
          )}
          {dates._tag === 'Loaded' ? (
            <Dates confirmed={dates.confirmed} now={now} />
          ) : (
            <p className="text-sm text-red">
              Confirmed dates could not load: {dates.reason}
            </p>
          )}
          <Profiles counts={result.dashboard.profiles} />
          <ProfileOverviews
            profiles={result.dashboard.overviews}
            page={page}
            hasMore={result.dashboard.hasMoreProfiles}
          />
          <Setups counts={result.dashboard.setups} />
          <Events events={result.dashboard.events} />
        </>
      )}
    </main>
  )
}
