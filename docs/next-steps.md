# Next steps

What is left between the code and PRODUCT.md after the demo build of the pick flow (PR #12,
merged 2026-10-25). PRODUCT.md is the source of truth; this file only tracks the gap. Remove an
item when it ships, and record any product decision in [decisions.md](decisions.md).

Ordered roughly by what blocks a real user most.

## 1. Getting connected

- **Connector sign-in.** The MCP server knows who is calling only from an `Authorization` header.
  An agent cannot set that header, so today a human has to re-add the server with their token
  after publishing. PRODUCT.md, Distribution: "Starting is one link or connector the human taps."
  Fix with OAuth on the MCP server, which the ChatGPT and Claude directories also expect. A
  stopgap for demos is a `token` tool argument, at the cost of the token appearing in the
  transcript.
- **One install for skill and server.** `.claude-plugin/plugin.json` bundles only the skill.
  Declare the MCP server there too, so installing the plugin brings both.
- **Server instructions.** `SERVER_DESCRIPTION` in `apps/api/src/mcp.ts` is exported but never
  sent: `@effect/ai` 0.37's `McpServer` has nowhere to put server instructions in the handshake.
  A host with only the connector sees the tool descriptions and nothing else, which is why the
  `swipeless_publish` description carries the interview guidance.

## 2. Reaching humans directly

Each of these needs a choice first.

- **SMS and email provider.** `Notifier` only logs (`apps/api/src/notifier.ts`). Replace it with a
  real adapter for date requests, confirmations with the other person's number, reminders, the
  post-date check-ins ("did you enjoy your date?", and a week later "did you see them again?"),
  and delete links. Needs: a provider, and a sender for Iceland.
- **Phone confirmation by SMS code.** PRODUCT.md, The brief and the profile: "Phone number is
  required and confirmed by SMS code." Not built.
- **Small pages.** Photo upload, yes or no with the optional one-tap reason, feedback, report,
  delete, and later pay. Needs: where they live (routes on `swipeless-api` or a new app) and how
  links are signed. The photo then moves out of the publish call and off `attach_photo.py`.
- **Saying yes or no from a page.** A page that confirms or declines must drive the same
  `SetupLifecycle` as the agent, so both paths share one state machine.

## 3. A model on the service

PRODUCT.md, Matching, calls for a model on the service side. Needs: provider and model.

- **Tailored briefs.** Candidates and the note's `counterpart.brief` carry the stored brief
  today. PRODUCT.md: "The full brief never leaves swipeless; other agents only see a version
  tailored to them."
- **Suggested dates.** `DateSuggesterRules` (`apps/api/src/date-suggester.ts`) picks from a few
  curated Reykjavík cafés and Thursday evening or Saturday afternoon. A model that reads both
  availabilities replaces it behind the same interface.
- **Tests.** A deterministic fake for the model, alongside the existing embedding fake.

## 4. Matching rules not yet enforced

- **Age and distance filters.** Candidates are filtered by approval, gender interest, country and
  existing pairs. Age and radius are not filtered; the agent judges them.
- **Per-man request limit in Iceland.** PRODUCT.md, Matching: "the service also limits how many
  date requests each man receives". No number is set.
- **Pick history.** The weekly ceiling counts picks from setup rows, and re-picking an expired
  pair replaces its row. Harmless for a safety limit; give picks their own append-only log if the
  ceiling ever matters for billing.

## 5. The Iceland test

PRODUCT.md, How we know it works. None of this is built.

- Date outcomes: said yes, showed up, glad they went, second dates, reports.
- The signal: at least 40% of people who went on a date ask for another within 30 days.
- The agent's picks against the service's own ranking, about 160 suggestions each.
- The weekly "find me a date" run against ChatGPT, Claude, Gemini, Dots and Muse.

## 6. Getting found

PRODUCT.md, Distribution. llms.txt, an agent card, the MCP Registry, listings in the ChatGPT and
Claude directories, and pages that answer how to get someone a date.

## 7. Later

- **Payment.** Free while testing, later $15 per confirmed date, paid through a link sent by SMS
  or email, never inside the chat.
- **Domain.** The service lives on `*.vercel.app`. The skill hardcodes the API URL, so moving it
  is also a skill release.

## Waiting on a decision

These are the maintainer's to decide. Do not build them first.

- **PRODUCT.md Status line.** It still says the code runs the older flow. The pick flow, the note
  with first name and photo, the review queue and service-suggested dates are now built. SMS,
  tailored briefs and a model are not.
- **One question per message.** The skill now asks one question per message, on the
  maintainer's request. PRODUCT.md, The idea, says "a few questions at a time".
- **Another time or place.** Whether the picked person can ask for a different time or place, or
  only say yes or no. Open in PRODUCT.md. Today a clash can only be a no, which closes the pair.
- **The reviewer sees the photo.** PRODUCT.md says the photo is shown to the one person a date is
  with. The person who checks each profile sees it too.
- **Pause or removal rules.** Number of no-shows, reports, and who reviews them. Open in
  PRODUCT.md.
- **Smitten's name.** Whether swipeless carries it publicly. Open in PRODUCT.md.
