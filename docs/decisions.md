# Decision log

Append-only. One entry per decision that changes PRODUCT.md. Newest at the bottom.

## 2026-09-10: Founding decisions

Settled in a structured interview (Matt Pocock's grill-me skill) between the maintainer and
Claude. Everything in PRODUCT.md as of this date comes from that session. Notable rejected
alternatives:

- Feeding profiles into the Smitten pool. Rejected for v1: Smitten's backend has no partner
  API, no OAuth, and no agent identity, so the bridge is real work and would tie an unverified
  alpha to a live brand.
- Showing the human a shortlist before the agent expresses interest. Rejected: the point of the
  experiment is agent autonomy, and the date confirmation is the veto.
- Photos in briefs. Rejected: agents rarely hold photos, and text-only keeps both humans blind.
- Names considered and dropped: unseen, blindfold, veiled, firstsight, redacted, sightunseen
  (existing dating products or squatted), blindpair, blindhandshake, zkdate (clean but weaker).
- Stack: Hono + zod replaced by Effect end to end on the maintainer's request the same day.

## 2026-09-10: Setup lifecycle decisions

Settled after the first architecture review, when the service stubs were implemented. The
maintainer chose each of these from a short list of options.

- Add `doubleblind_decline`, the eighth tool. Either agent may decline once a setup is mutual and
  before both confirm. Final, unexplained. Rejected: leaving `declined` unreachable, or removing
  the status.
- A setup expires after fourteen days without a transition; confirmed setups do not expire.
  Rejected: seven and thirty days.
- An unreciprocated interest that expires closes the pair permanently. Rejected: letting the
  pair retry.
- The weekly interest cap keeps two numbers: the skill's default of five is the agent's own
  restraint, the service's ceiling of twenty is a safety limit. Rejected: aligning both to five
  or twenty.
- Deletion is a hard delete. A deleted token reads as unknown (401); 410 is reserved for the
  ninety-day expiry. Rejected: a scrubbed tombstone row per deleted profile.
- The MCP delete tool answers `{ deleted: true }` because MCP cannot carry an empty result. REST
  keeps 204.
- Tests substitute only what sits outside the process: embeddings, blob storage, SMS and the
  clock. They drive the real web handler, and SQL runs against the docker Postgres. Rejected: a
  repository seam with an in-memory fake, and fake services behind the transports.
- Not a PRODUCT.md change but recorded here: `Setup` carries `counterpartPrivateLayer` once
  confirmed, so the first confirmer can recover the private layer PRODUCT.md promises to both.

## 2026-09-11: Hosting, secrets and release decisions

Settled with the maintainer before any infrastructure existed. Four questions were put
explicitly; the rest follow from them.

- Ship on `*.vercel.app` for now and move to a custom domain later. `doubleblind.date` was
  bought but has no DNS records at all, and nothing about the alpha needs the name yet.
  Rejected: waiting for DNS before the first deploy.
- Two Vercel projects rather than one: `doubleblind-api` rooted at `apps/api` and
  `doubleblind-admin` rooted at `apps/admin`. They have different runtimes, different secrets and
  very different blast radii. Rejected: one project serving both behind rewrites.
- Postgres from Neon through the Vercel Marketplace. pgvector is a first-class extension there
  and the connection string is injected into the project rather than copied by hand. Rejected:
  a self-managed instance, and Supabase, which brings an auth and storage stack we do not use.
- Deployment runs from GitHub Actions, not from Vercel's Git integration. The repository is
  deliberately not connected to either Vercel project, so nothing reaches production that has not
  passed `bun run verify`, the database suites, and the migration step, in that order. Rejected:
  letting Vercel build on push, which deploys before tests finish and cannot order migrations
  against the deploy.
- The skill is released to npm and tagged as a GitHub release; the repository stays private.
  Rejected: making the repository public so the skill could be installed from a git URL.
- Secrets live in a new 1Password vault, `doubleblind`, which is what `.env.template` already
  pointed at. `AUTH_SECRET` was generated for this project. `OPENAI_API_KEY` is currently the
  key from the shared `Vercel Functions Environment` vault, so doubleblind's embedding usage
  bills to that account until a dedicated key replaces it.
- The MCP server is stateless per request: `@effect/rpc`'s HTTP protocol allocates a client id
  per POST and tears it down with the request scope, and neither `@effect/rpc` nor `@effect/ai`
  keeps a session map. That is why serverless functions are a safe host for it, and why the
  skill does not need sticky routing.

## 2026-10-01: swipeless rebrand and interview-led profiles

The maintainer approved a new brand page and the direction below. Each item names the chosen
option and the alternatives it beat.

- D1. Rename everything to `swipeless`: product, skill, plugin, npm package, MCP server, the
  `swipeless_*` tools, the REST group, `@swipeless/*` workspace scopes, the `Swipeless` service
  class, env, docker and CI names, the GitHub repo, both Vercel projects, the Neon database
  (`swipeless-prod`), the Blob store (`swipeless-photos`) and the 1Password vault. All doubleblind
  test data was discarded rather than migrated, so credentials simply live in
  `~/.swipeless/credentials.json` with no fallback. The name check found a Portuguese startup
  called Swipeless that Tinder is suing, an iOS app using "swipeless" in its title, and the phrase
  in generic use; the maintainer accepted that risk.
  Rejected: keeping `doubleblind`.
- D2. Interview, not inference. The brief comes only from what the human says in the
  conversation. The agent mines nothing from memory, connected tools, account metadata or files,
  asks core facts directly, asks email and photo as plain optional questions, and reads the
  calendar for availability only after asking. It says up front that the conversation stays
  between the two of them until the human approves what is shared. Rejected: inference-first
  briefs from existing memory with an interview only to fill gaps, which was the founding
  decision.
- D3. Warm voice to the human, dry protocol underneath. The five Voice rules stand. Rejected: the
  founding technical, protocol-like tone toward the human.
- D4. The note before yes shows age, a few approved details, why you might click, venue and time.
  First name, phone and photo stay in the private layer until both confirm. Rejected: the first
  name in the note before yes.
- D5. Declines stay invisible. The other agent sees only `declined`, and the agent never tells its
  human that someone declined them. Rejected: telling the human about declines.
- D6. Rescheduling a confirmed date is deferred; no new capability. Rejected: reschedule in v1.
- D7. Adopt the notebook visual identity for the admin app and as the documented identity.
  Waitlist, city-by-city rollout and pricing stay deferred. Rejected: a waitlist now.
- D8. The agent learns from its human's answers. After a no it may keep a short private note of
  what didn't fit, without asking why, in `~/.swipeless/notes.md`, and use it on later candidates.
  Never shared, never sent to the service.

Done the same day: GitHub repo renamed, Vercel projects renamed in place (ids unchanged) with
`swipeless-*.vercel.app` domains, Neon and Blob recreated under swipeless names, the `DATABASE_URL`
Actions secret replaced. Still open:

- Publish the npm package `swipeless`, configure its trusted publisher (repo `swipeless`,
  workflow `deploy.yml`), and deprecate `doubleblind` with a pointer to it.
- Pick and buy a domain.

## 2026-10-01: Dedicated OpenAI key

The shared `Vercel Functions Environment` key was revoked, which broke every publish with a 500
at the embedding step. swipeless now has its own key, stored in the `swipeless` vault and set on
the `swipeless-api` project for production and development. Embeddings stay on OpenAI
`text-embedding-3-small`. Rejected: switching embedding providers, and dropping embeddings for
filter-only matching.

## 2026-10-20: Aligned with the business case

PRODUCT.md was realigned with "swipeless. 9 questions." in Notion. Rejected alternatives were
not recorded at the time.

- The note shows the other person's first name and photo. Only the phone number stays in the
  private layer until both say yes. This reverses D4 of 2026-10-01.
- A photo is required to publish. The phone number is required and confirmed by SMS code.
- The service reaches humans directly by SMS and email, with small single-purpose pages for
  anything that needs a tap. No browsing site, no login.
- A person checks every profile before it goes live, including that they are 18+. This replaces
  "no identity verification".
- Iceland is the lab, recruited through a prompt inside Smitten. This replaces "no Smitten
  branding anywhere"; whether swipeless carries Smitten's name stays open.
- Post-date check-ins by SMS or email, and the one signal: at least 40% of people who went on a
  date ask for another within 30 days.

## 2026-10-23: One pick, a suggested date

PRODUCT.md was realigned again with the same business case, which now wins where the two
disagree. Rejected alternatives were not recorded at the time.

- One agent's pick starts a setup. Mutual agent interest is no longer required. Rejected: the
  founding mutual-interest flow.
- swipeless suggests the date, a public place and a time. Agents no longer propose or counter,
  and `swipeless_propose` is removed. This leaves seven tools. The question of whether the picked
  person can ask for another time or place is open.
- The picking human sees the note first. On their yes, the other person gets a date request by
  SMS. Both must say yes.
- Briefs are tailored to the person looking, and the full brief never leaves swipeless. This
  needs a model on the service side and reverses "no server-side LLM".
- Picking may use everything the agent knows about its human. The brief still comes only from
  the interview.
- Every no offers an optional one-tap reason on our page. The agent still never asks why.
- Payment: free while testing, later $15 per confirmed date, paid through a link outside the chat.
- Distribution's main bet is agents finding and suggesting swipeless on their own. The ChatGPT and
  Claude directories and the link inside Smitten are the fallback.

## 2026-10-23: Demo build of the pick flow

Implementation choices for a demo of the 2026-10-23 flow. These are not PRODUCT.md changes.

- Date suggestions come from a deterministic, rule-based `DateSuggester`: curated public venues
  per city and the next Thursday evening or Saturday afternoon. A model replaces it later.
- `Notifier` only logs. No SMS or email provider is chosen yet, so the picked person's agent sees
  a date request the next time it runs `swipeless_setups`.
- Candidates still carry the stored brief. Tailoring waits for the service-side model.
- The photo still travels with publish, and the phone is not yet confirmed by SMS code. Both move
  to a texted small page once pages exist.
- Profiles start `pending`. The admin review queue approves or rejects them, and only approved
  profiles are matched.

## 2026-10-25: Basic email through Resend

Implementation choices, on the maintainer's request. Not PRODUCT.md changes, but two of them
bend it, noted below.

- Email goes through Resend, as plain text, from a shared `@swipeless/email` package used by the
  API and the admin site. Only people who gave an email get one; email stays optional. Without
  `RESEND_API_KEY` every email is only logged.
- Three emails are automatic: "you're live" when the super admin approves a profile, the date
  request to the picked person, and "it's a date" with the other person's number to both when
  both say yes. PRODUCT.md says the date request and the number go by SMS; email stands in until
  there is an SMS provider.
- "how was the date?" is not scheduled. The admin site lists confirmed dates, and the super admin
  presses a button to email both, once per date. Replies come back as plain email. PRODUCT.md
  words the question "did you enjoy your date?"; the maintainer asked for "how was the date?".
- Emails are a handwritten note on the notebook page from Visual identity, with a plain-text
  twin. The date request has "do you want to go out?" with yes and no boxes.
- The boxes link the small yes-or-no page PRODUCT.md describes, served by the API at `/answer`.
  A link is signed for one person and one setup, and stands in for the bearer token there only.
  GET only shows the note, because mail scanners open every link; the answer is the page's POST,
  through the same confirm and decline as the tools. No optional reason on a no yet.
- The admin site has a local-only tool to pick and say yes as someone, to test the emails. It
  breaks PRODUCT.md, Trust ("the human, not the AI, says yes to every date"), so it is hidden and
  refused in production.
- The date request shows the other person's photo and a line on why the two might click, and
  leaves the street address out of the note (the plain-text twin keeps it). The line is written
  per email by Claude (`claude-opus-5-5`, low effort) from both approved briefs, behind a
  `FitWriter` seam; without `ANTHROPIC_API_KEY` or on any failure the email goes out without it.
  This is the first server-side language model, which the 2026-10-23 entry anticipated for
  tailored briefs. Embeddings stay on OpenAI: Anthropic has no embeddings API.
- The photo in the email loads from `/answer/photo`, signed like the answer link and served only
  while the setup is open to that person. Stored photos' own links expire in ten minutes, too
  soon for an email.

## 2026-10-25: swipeless.me

- The domain is `swipeless.me`, bought through Vercel under `smitten-server`. The marketing site
  is at the apex, the API and MCP at `api.swipeless.me`, and the admin at `admin.swipeless.me`.
  Each one is attached to its Vercel project, and `www.swipeless.me` redirects to the apex
  (308). This closes "Pick and buy a domain" from the
  2026-09-11 entry.
- Code defaults, the skill, llms.txt and the site's canonical links all name the new hosts. The
  `swipeless-*.vercel.app` addresses keep working, so installed skills and links in emails
  already sent don't break.
