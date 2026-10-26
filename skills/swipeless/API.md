# swipeless API

Base URL `https://api.swipeless.me`. MCP at `/mcp`. REST routes below carry the same names as the
MCP tools and take the same JSON. Every call except `publish` needs
`Authorization: Bearer <token>`. Over MCP only, a host that cannot set headers (a ChatGPT
connector, a Dot) may pass the token as a `token` argument on each tool instead; a header always
wins. This is a stopgap until OAuth: the token then sits in the conversation, so use the header
whenever you can.

The authoritative schemas live in `packages/shared` in the repo. This file is the agent-facing
summary.

| Tool | REST | In | Out |
|---|---|---|---|
| `swipeless_publish` | `POST /publish` | core fields + brief, firstName, photoUrl, privateLayer, email?, standingInstructions? (flat object) | `{ profileId, token }` |
| `swipeless_candidates` | `GET /candidates?limit=10` | none | `{ candidates: [{ profileId, core, brief, score }] }` up to 10 |
| `swipeless_interest` | `POST /interest` | `{ profileId }` | `{ setup }` |
| `swipeless_setups` | `GET /setups` | none | `{ setups: setup[] }` |
| `swipeless_confirm` | `POST /confirm` | `{ setupId }` | `{ status, privateLayer? }` |
| `swipeless_decline` | `POST /decline` | `{ setupId }` | `{ status: "declined" }` |
| `swipeless_delete` | `DELETE /profile` | none | MCP `{ deleted: true }`, REST 204 |

## Shapes

```
publish body (flat): { ...core, brief, firstName, photoUrl, privateLayer, email?, standingInstructions? }

core: {
  age: 18..99,
  gender: "man" | "woman" | "non_binary",
  interestedIn: gender[] (non-empty),
  city: string, country: "IS" | "GB" | ... (ISO 3166-1 alpha-2),
  radiusKm: 1..500 (default 25),
  availability: string, max 200   // "weekday evenings after 19:00, Sunday afternoons"
}
brief: markdown string, max 6000 chars
firstName: string, 1..80 chars    // shown in the note to the one person a date is with
photoUrl: https URL or data:image/(jpeg|png|webp);base64,...   // required; see Photo files
privateLayer: { phone: "+354..." }   // E.164; released only when both say yes
standingInstructions: free text, max 1000 chars, e.g. "no weekdays"

candidate core: core without radiusKm. Candidates carry no name, photo or phone.
score: 0..1, higher is closer

setup: {
  setupId: uuid,
  counterpart: { profileId, firstName, age, photoUrl, brief },
                           // photoUrl signed, "" if none; brief is the text candidates get
  status: "suggested" | "requested" | "confirmed" | "declined" | "expired",
  date: { venue: { name, address }, time: ISO-8601 },     // suggested by swipeless
  youPicked: boolean,      // your agent made a pick for this pair
  youConfirmed: boolean,   // your human said yes; the other side's flag is not exposed
  counterpartPrivateLayer?: { phone },                    // only when confirmed
  createdAt, updatedAt, expiresAt: ISO-8601
}
```

## Setup lifecycle

A pick creates a setup with a date swipeless suggests for both people: a public place and a time.
A setup carries one status at a time: `suggested`, `requested`, `confirmed`, `declined`, or
`expired`. A pair has at most one setup at a time.

- `swipeless_interest` is your pick. The target and your own profile must both be live,
  otherwise `404`. It returns the setup as `suggested`, visible only to you, with the
  counterpart's first name, age, photo and brief. Repeating the pick on a live setup returns the same
  setup and costs nothing against the cap. If the other side already picked you and the setup is
  still live, you get that same setup, both sides now see it, and its 14 days start again.
  Picking a pair whose setup is `declined` answers `404`: that pair is closed for good.
- `swipeless_confirm` records your human's yes. If the other human has not said yes, the status
  becomes `requested` and the setup becomes visible to them as a date request. When both have said
  yes, the status becomes `confirmed` and the response carries the counterpart's `privateLayer`.
  `swipeless_setups` returns it too, as `counterpartPrivateLayer`, so you need not store it.
  Confirming twice is a no-op. Confirming a `declined` or `expired` setup answers `409`.
- `swipeless_decline` records a no from either side that can see the setup, any time before both
  have said yes. It is final: the status becomes `declined` and the pair is never shown to each
  other again. Declining a `confirmed`, `declined` or `expired` setup answers `409`. No reason
  travels with a decline, and the other side sees only `declined`, if it could see the setup at
  all. When both agents picked, both sides see a later `declined`.
- A setup reads as `expired` after 14 days with no transition, or once its suggested time has
  passed before both said yes. Every transition starts the 14 days again. A confirmed setup does
  not expire, and neither does a declined one.
- Expiry does not close the pair. An expired pair can come back in `swipeless_candidates`, and a
  new pick starts a fresh setup with a new `setupId` and a new suggested date; the old `setupId`
  answers `404`. Only `declined` closes a pair for good.
- The weekly ceiling is 20 picks. Past it, `swipeless_interest` answers `429` with
  `retryAfterSeconds`, the wait until your oldest pick in the window falls out of it.

Visibility: a side sees a setup if its agent picked, or the status is `requested` or `confirmed`.
A `declined` or `expired` setup stays visible only to a side that could see it before. A setup
you cannot see is absent from `swipeless_setups`, and `swipeless_confirm` and `swipeless_decline`
answer `404` for it.

The picked person may also answer without an agent. Their date request email links a small page,
`/answer`, signed for that one person and setup. Opening it changes nothing; its yes or no button
calls the same confirm or decline as the tools. So a setup can move to `confirmed` or `declined`
between two of your `swipeless_setups` calls without your human saying anything to you.

## Candidates

Candidates are live profiles that pass the hard filters (mutual gender interest, same
country), ranked by similarity to your brief. Age and distance are not filtered yet, so judge them
yourself. Anyone you have a live, confirmed or declined setup with is left out; an expired pair can
come back. A profile is live as soon as it is published, so `swipeless_candidates` works right
after `swipeless_publish`.

## Photo files

`photoUrl` is required to publish and accepts either an existing HTTPS photo URL or an inline
image data URI. An inline photo is sent as part of `POST /publish`; the server uploads its decoded
bytes to private Vercel Blob storage. Postgres stores only its object key, never the base64 image.
An inline photo must be a real JPEG, PNG or WebP of at most 1 MiB whose bytes match the type in
the data URI; anything else is refused like any other invalid field (400, or a tool error).
No public hosting or separate upload endpoint is needed. For now the photo travels with publish;
a small page texted to the human will replace this.

Photos are absent from candidate responses. A setup's `counterpart.photoUrl` is a signed URL,
valid for 10 minutes, present as soon as you can see the setup. Call `swipeless_setups` again to
obtain a fresh link after expiry. Download using the full URL without modifying its query
parameters; save privately and show the image with the host's image viewer. Never share the
signed URL publicly. Profile deletion removes the Blob object and invalidates delivery through
the profile's photo route.

The admin fetches stored photos through `/api/photos/<profileId>` using the super-admin
session. Other callers need a valid short-lived signature; knowing a profile ID or object key
is not enough. Existing external HTTPS photo URLs continue to point to their original host.

For an attachment or local path, the agent prepares the approved profile JSON in a private
scratch directory, then runs the bundled helper (resolve its path relative to this skill). It
sets the top-level `photoUrl`:

```sh
uv run /path/to/skill/scripts/attach_photo.py \
  --profile /private/scratch/profile.json \
  --photo /path/to/chosen-photo.jpg \
  --output /private/scratch/publish.json
```

The helper accepts Pillow-supported images, applies orientation, strips metadata, and encodes
a JPEG of at most 1 MiB. It leaves the original file intact and creates the JSON with owner-only
permissions. It does not publish. If `uv` is unavailable, use Python with Pillow installed.
Keep the base64 out of chat, tool output, and command arguments.

After the human approves the completed overview, upload the file using the REST fallback:

```sh
curl --silent --show-error --fail-with-body \
  https://api.swipeless.me/publish \
  --header 'Content-Type: application/json' \
  --data-binary @/private/scratch/publish.json \
  --output /private/scratch/publish-response.json
```

Use an owner-only scratch directory (`umask 077`) and save the returned token to
`~/.swipeless/credentials.json` with mode 0600 before removing temporary payload/response
files. Never print the token. On a timeout or ambiguous result, do not automatically republish:
the request may already have created a profile. Check the response before retrying.

Base64 is used only to transport a local image in the publish request. Do not embed image
data in the brief. Other people's photos go only to the human they were released to.

## Errors

Standard HTTP codes. `400` body fails validation. `401` bad or missing token. `404` unknown,
unapproved or closed profile, or a setup you cannot see. `409` action not valid for the setup's
current status, such as a yes after a no; the body carries that `status`. `410` profile expired.
`429` weekly pick ceiling reached, with `retryAfterSeconds`.

## Profile lifecycle

Profiles expire after 90 days without any authenticated call. Any call counts as a check-in.
Deletion cascades to brief, photo, interests, setups, and embeddings.
