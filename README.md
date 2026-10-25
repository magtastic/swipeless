# swipeless

No swiping. No small talk. Just a date.

Your AI finds someone worth meeting and sends you one message with their name, a photo, a time
and a place. You say yes or no. When you both say yes, you get each other's numbers. A person at
swipeless checks every profile before it goes live.

Read [PRODUCT.md](PRODUCT.md) first. It is the source of truth for what this is.

## For agents and their humans

Install the skill into any agent that reads skill folders:

```sh
npx skills add magtastic/swipeless
```

Or, in
Claude Code, add this repo as a plugin. Then say "find me a date". The skill lives in
[skills/swipeless](skills/swipeless/SKILL.md) and talks to the `swipeless` MCP server through the
`swipeless_*` tools.

## For people working on the service

Bun workspace, Effect end to end.

```
apps/api        Effect HttpApi (REST) + MCP server, deployed as Vercel functions
apps/admin      Next.js admin, Google OAuth
packages/shared Effect Schema contract shared by API, MCP, and docs
packages/db     Postgres + pgvector via @effect/sql, migrations via drizzle-kit
skills/         The agent-facing skill, installable with npx skills add
docs/           Decision log, next steps
```

```sh
bun install
bun run get:env:dev  # .env for local work: secrets from 1Password, the docker database
                     # (get:env:prod writes production values; only for deliberate prod work)
bun run db:up        # local Postgres with pgvector on :5434
bun run db:migrate
bun run dev
bun run verify       # typecheck + biome + tests
```

## Hosting and CI

| | |
|---|---|
| API + MCP | https://swipeless-api.vercel.app |
| Admin | https://swipeless-admin.vercel.app |

Both are Vercel projects under the `smitten-server` team. Neither is connected to this repo on
Vercel's side, deliberately: GitHub Actions owns deployment, so the tests gate it.

`*.vercel.app` is where this lives for now, not where it lands. The swipeless domain is not
chosen yet. The skill hardcodes the API URL, so moving it is also a skill release.

- `.github/workflows/pr.yml` runs on pull requests to `main` and on pushes to `main`.
- `.github/workflows/deploy.yml` runs on pushes to `main`: verify, then migrate, then the two
  Vercel deploys in parallel, then the skill release. Each stage waits for the one before it.
- Both call `.github/workflows/verify.yml`, which is the only definition of the checks: `bun run
  verify` plus `bun run test:db` against a pgvector service container on :5434.

### Secrets

Two repository secrets, in Settings → Secrets and variables → Actions. Everything else the
running services need is a Vercel project environment variable, not an Actions secret.

| Secret | Where it comes from |
|---|---|
| `VERCEL_TOKEN` | vercel.com → Account Settings → Tokens, scoped to the `smitten-server` team |
| `DATABASE_URL` | 1Password, item `DEV - swipeless/DATABASE_URL`. Same value as `bun run get:env:prod` writes. The role must be allowed `CREATE EXTENSION vector` |

### Releasing the skill

npm uses trusted publishing through GitHub Actions, without an npm token. The package's
trusted publisher must name owner `magtastic`, repository `swipeless`, and workflow
`deploy.yml`, with no environment name and **Allow npm publish** enabled. The release job
requests `id-token: write` and uses npm 11.12.1 to authenticate through OIDC.

`npx skills add magtastic/swipeless` installs from GitHub, not from npm: the `skills` CLI
resolves git and URL sources only, and keys the install directory off the `name` in SKILL.md
frontmatter. That path needs the repo to be public and nothing else. The npm package exists
alongside it, for projects that depend on the skill and run `npx skills sync`, which scans
`node_modules` for a `SKILL.md` at a package root.

To cut a release, bump the version in **both** `skills/swipeless/package.json` and
`.claude-plugin/plugin.json` to the same number, then merge to `main`. The release job fails if
the two disagree. It publishes to npm and cuts a `v<version>` GitHub release, and skips either
one cleanly if that version is already out — so merges that do not touch the version are a no-op.

### Deploying by hand

If Actions is down. From the repo root, with `DATABASE_URL` and a Vercel token in the
environment:

```sh
bun install --frozen-lockfile
bun run verify
bunx drizzle-kit migrate

export VERCEL_ORG_ID=team_gDnXmbne0PuTiJ95im5rbTr6
export VERCEL_PROJECT_ID=prj_KnEDfyETA8ldC7VZvB2YjDR1jnhk   # swipeless-admin: prj_ImBVG3ODEhUEcAHcEMbQlaBMZTgi
npx vercel@59.16.0 pull --yes --environment=production --token="$VERCEL_TOKEN"
npx vercel@59.16.0 build --prod --token="$VERCEL_TOKEN"
npx vercel@59.16.0 deploy --prebuilt --prod --token="$VERCEL_TOKEN"
```

Migrate before deploying the API, never after. Repeat the last four lines with the other project
id for the admin.

## Private photos

Uploaded photos live in the private Vercel Blob store `swipeless-photos`. The database's
`profiles.photo_url` field stores an object key for uploads; existing external HTTPS URLs
remain supported. `BLOB_READ_WRITE_TOKEN` is configured on the API and admin production
projects and stored in the `DEV - swipeless` 1Password vault.

Publish accepts a small inline image as transport, uploads decoded bytes to Blob, and saves
only the key. The note carries a link valid for ten minutes as soon as a setup is visible;
checking setups returns fresh links. The admin's `/api/photos/:profileId` route checks a super-admin session or a valid
signature on each request and sends `Cache-Control: private, no-store`. Deleting a profile
removes its stored image. Local development can set `PHOTO_BASE_URL` to its admin origin.

To migrate legacy inline photos after deploying both services, run with production database
and Blob credentials in the environment:

```sh
bun apps/api/scripts/migrate-photos.ts
```

The migration verifies uploaded bytes before conditionally replacing each inline value and
can be rerun. It prints counts only. It does not copy existing externally hosted URLs.
