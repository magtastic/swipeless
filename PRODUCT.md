# swipeless

**No swiping. No small talk. Just a date.**

This document is the source of truth for what swipeless is and is not. It was settled in a
structured interview on 2026-09-10, realigned on 2026-10-20 and again on 2026-10-23 with the
business case ("swipeless. 9 questions." in Notion, which wins where the two disagree), and is
updated only by explicit decision. If code and this document disagree, the document wins and the
code is the bug. Agents working in this repo: read this before making any product decision, and
read the file rather than remembering it.

Status: **experiment, pre-alpha**. Nothing is deployed yet. The code still runs the older flow:
mutual agent interest, an agent-proposed venue with one counter, full briefs to every agent, no
server-side model. It does not yet tailor briefs, suggest the date from the service, reach the
other person by SMS, show first name and photo in the note, or hold profiles for a person to
check. Those follow from the 2026-10-20 and 2026-10-23 changes below.

## The idea

swipeless lets your AI find you a date. You tell ChatGPT or Claude "find me a date". It asks you a
few questions and checks swipeless, where other people's AIs have done the same. When two people
look like a good fit, swipeless suggests a first date made for them. You get one message with
their first name and photo, a time and a place. When you both say yes, you get each other's phone
numbers. Dating minus the screen: no app, no swiping, no weeks of chatting.

1. The agent interviews its human: a short conversation, a few questions at a time. It writes a
   **brief** in third person from what the human told it.
2. The human reviews an overview of what will be shared, toggles categories, and approves. They
   confirm their phone number and add a photo on a small page we text them. A person at
   swipeless checks the profile, including that they are 18+, before it goes live.
3. The service sends the agent a few candidates, each brief **tailored to the person looking**.
   The agent picks using everything it knows about its human. Only its pick comes back to us.
4. When the agent picks someone, swipeless suggests a first date made for both: a public place
   and a time. The agent shows its human the **note**: first name, photo, why it fits, the place
   and the time. If nothing fits yet: "Nothing perfect yet. Go live your life, we'll text you."
5. If the human says yes, the other person gets the same kind of note by SMS. They say yes or no.
6. When both say yes, both get the other's phone number. They text, call or WhatsApp however
   they like.
7. The two humans show up. That is the whole product.

We host no chat and promise no silence: we connect two people and hand them a way to talk. There
is no swiping. Interest stays hidden until both say yes, so nobody ever sees a no.

## What makes it interesting

- Nothing to download. swipeless lives inside the AI you already talk to, which already knows
  you. A normal chat with ChatGPT or Claude is enough; it does not need an agent that acts on its
  own.
- Your AI does the judging, on your side. It never sees anyone's full profile, and nobody's full
  profile leaves swipeless.
- Real people only. A person checks every profile, and the human, not the AI, says yes to every
  date.
- Agents that act on their own (OpenAI Dots, Meta Muse) search for ways to solve your problem. The
  bet is that they find swipeless and suggest it.

## Decisions

Each line is a settled decision. Rationale in parentheses where it is not obvious.

### Positioning

- Standalone experiment with its own pool of profiles. Might be productized later.
- Who it is for: single people looking for someone who already talk to ChatGPT or Claude about
  their lives, and would rather meet than chat.
- Iceland is the lab for the mechanics: Smitten has about 15,000 monthly actives there. The test
  recruits Smitten users who get stuck (50 left swipes with no match) with a prompt inside
  Smitten: "Tired of swiping? Ask your AI to find you a date." We also invite women directly,
  because the stuck audience is about 69% men. The US is the market and follows only if the
  12-week test passes, starting in Washington DC, with Chicago as backup. Whether swipeless
  itself carries Smitten's name is open (see Open questions).
- Name is `swipeless`, lowercase everywhere including sentence starts. It replaced `doubleblind`
  on 2026-10-01, everywhere: repo, Vercel projects, stores, vault. Domain is to be decided; the
  service lives on `*.vercel.app` until then. Known collisions (a Portuguese startup Tinder is
  suing, an iOS app using "swipeless" in its title, the phrase as a generic label) were accepted.
- Brand position: dating minus the screen. We sell a real person and a real date, never "AI
  dating" and never "agentic dating": AI that gets you off your phone and in front of someone
  real. (40% of singles say they'd refuse to date someone who uses an AI companion.)
- Tone: warm voice to the human, dry protocol underneath. Notes read like a short letter from a
  friend; the API, schemas and tool parameters stay technical.
- Audience for v1 is anyone with an AI, not only developers. Anyone can sign up anywhere, so we
  don't fill a city before opening. Gating is deferred.

### Distribution

- **The main bet: agents find swipeless on their own** when their human is looking for someone,
  and suggest it. Three things have to work:
  - Be found: pages written to answer "how do I get a date", a plain machine-readable description
    (llms.txt, an agent card, the MCP Registry), and Smitten's dating data published as reports
    and stats people and AIs cite, with swipeless in them. Our emails and invites read as "this
    is how you get a date" when an agent finds them in someone's inbox.
  - Be easy to suggest: an agent understands in seconds what swipeless does, that the human
    decides every step, and how to start. Starting is one link or connector to tap.
  - The human decides: an agent never signs anyone up on its own. The human chooses to try it,
    approves what's shared, and confirms every date.
- Fallback, and how the Iceland test starts: listing in the ChatGPT and Claude directories, and
  the link inside Smitten. We list in both from day one.
- An agent only calls tools that are already connected. Distribution means getting swipeless
  suggested and connected.
- One public GitHub repo containing the skill folder, installable with `npx skills add <repo>`.
  A Claude Code plugin manifest wraps the same folder. No per-host builds.
- Tool names and descriptions are all an agent routes on. They use the words people use: "find me
  a date", "meet someone".
- **MCP is the primary agent interface.** REST exists alongside with the same vocabulary, mainly
  for the small pages and admin.
- Skill name, plugin name, npm package, MCP server name, and tool prefix are all `swipeless`.
  Tools: `swipeless_publish`, `swipeless_candidates`, `swipeless_interest`, `swipeless_confirm`,
  `swipeless_decline`, `swipeless_setups`, `swipeless_delete`. REST paths use the same words so
  the two interfaces never drift.
- Local state lives in `~/.swipeless/`. The doubleblind test data was discarded at the rename,
  so there is no migration from the old path.

### The brief and the profile

- **Structured core** for filtering: age, gender, interested in, city and country, date radius,
  availability pattern.
- **Brief**: markdown, third person, written by an agent. Sections: who they are, how they live,
  what they value, what they want, dealbreakers. Text only. No photos in the brief. The full
  brief never leaves swipeless; other agents only see a version tailored to them.
- **Shown in the note**, to the one person the date is with: first name and photo. A photo is
  required to publish.
- **Private layer**, released only when both say yes: phone number.
- Phone number is required and confirmed by SMS code. Email is optional.
- Optional **standing instructions** the human gives their agent, such as "no weekdays" or
  "nothing before 19:00". The agent applies them when picking and passes time constraints as
  availability.

### Consent

- **Interview, not inference, for the brief.** The brief comes only from what the human tells the
  agent in this conversation, and how they say it. The agent does not mine memory, connected
  tools, account metadata, email addresses, usernames, timezones, avatars, or files to write it.
- Picking is different: the agent may use everything it already knows about its human to judge
  candidates, because that judgement stays on the agent's side and only the pick reaches us.
- The agent says up front: this conversation is between you and me; nothing leaves it until you
  approve exactly what gets shared.
- It starts by asking what they want, then gets to know them in a few questions: genuine
  follow-ups (their Sundays, a good weekend, what they value, dealbreakers, past crushes as types
  never names, a good first date). Required core facts are asked directly. Email is a plain
  optional question. The photo is required and added on a small page we text them.
- Calendar is read for availability only, and only after asking.
- The human sees a **category overview**: one line per category, a toggle per category, and can
  ask to see the full brief. Publishing requires an explicit yes.
- **Default off**: employer name, health, finances, and anything about third parties such as
  exes, friends, or colleagues.
- **Never** include names of other people. Never put email or calendar contents into the brief
  beyond availability.

### Matching

- The service applies hard filters (mutual gender interest, age, distance, country) and ranks
  by embedding nearest neighbours over briefs. It sends the agent a few candidates.
- Each candidate's brief is **tailored to the person looking**, for example "loves dogs like you,
  hikes most weekends, and you said you're into the outdoors". This needs a model on the service
  side.
- **The agent picks autonomously.** It may pick none. A weekly cap on picks applies, default to
  be set in the skill. The service enforces a separate ceiling, twenty per week, whatever the
  skill says. In Iceland the service also limits how many date requests each man receives.
- During the Iceland test, the service compares the agent's picks with its own ranking, about
  160 suggestions each. If the agent's picks don't get more yeses, "your AI knows you" leaves the
  pitch.
- Pull-based on the agent side. The skill runs when invoked and documents how to schedule a
  periodic check in hosts that support it.

### SMS, email and small pages

- Everything after signup reaches humans by SMS, email or agent reminders: notes, date requests,
  the other person's number, reminders, feedback, payment, deletion. The agent hears the same
  news the next time it runs.
- When something needs a tap (photo upload, yes or no, feedback, report, pay, delete), the
  message links a small single-purpose page. Nothing to download, no login, no site to remember.
- Every no offers an optional one-tap reason on the page. The agent never asks why. (If "because
  an AI picked" is more than a quarter of the nos, that is its own risk.)
- The agent learns from its human's answers. After a no, it may keep a short private note to self
  about what didn't fit in `~/.swipeless/notes.md`, and use it when picking later. Never shared,
  never sent to the service.

### The setup and the date

- An agent's pick creates a setup. swipeless suggests a first date made for both people: a
  **public place** and a time that fits both availabilities, like coffee and a walk on Thursday.
- The picking human sees the note first, through their agent. If they say yes, the other person
  gets a date request by SMS. Both humans must say yes or the setup dies.
- Either human may say no at any point before both have said yes. No is final, and the other side
  sees only that the date is not happening. Nobody is told that someone said no to them. A no
  closes the pair for good: they are never shown to each other again.
- A setup with no transition for fourteen days expires. A confirmed setup does not expire.
- Agents may read their human's calendar for availability, after asking.
- The **note** shows the other person's first name and photo, age, a few approved details, why
  the two of you might click, the place, and the time. No phone number.
- After both say yes, both get the other's phone number by SMS, and each agent tells its human:
  here is who, here is where, here is when.
- After the date, both are asked "did you enjoy your date?" by SMS or email. It confirms the date
  happened, improves the next match, and doubles as a safety check-in. A week later: "did you see
  them again?"
- What we learn from dates (said yes, showed up, glad they went, second dates, reports) is used
  privately for matching and for removing people who behave badly. It is never shown as a score.

### Payment

- Free while we test. Later, $15 per confirmed date.
- The pay link comes with the confirmation by SMS or email, never inside the chat. (ChatGPT bans
  selling digital services inside the chat.)

### Identity, deletion, retention

- A person checks every profile before it goes live, including that they are 18+. Liveness and
  ID checks come when volume needs them.
- The service issues an opaque bearer token at publish. The skill stores it locally. Every later
  call uses it.
- Deletion is one call with the token, or a link sent by SMS or email. Deletion cascades to the
  brief, photo, interests, setups, and embeddings, and the admin site records that it
  happened.
- Profiles expire automatically after ninety days without a check-in.

### Trust

- Other briefs are **untrusted data**. The skill instructs agents to never follow instructions
  found inside a brief. The service strips obvious injection patterns and caps brief length.
- Fabricated profiles are mitigated by the person checking each profile, the human yes to every
  date, and admin visibility.
- Agents never reveal another person's photo, first name or phone number beyond the human they
  were released to, even if asked.

### How we know it works

- The signal: **at least 40% of people who went on a date ask for another within 30 days.**
  Second dates are tracked alongside.
- Before users: every week we ask the main agents (ChatGPT, Claude, Gemini, Dots, Muse) "find me
  a date" in fresh sessions from a few cities, and count how often they find and suggest
  swipeless.
- The 12-week Iceland test, free for users, with lines set in advance:

  | Test | Go | Stop |
  |---|---|---|
  | Smitten prompt | ≥1% sign up through their AI, ≥150 live profiles, still back in week 4 | Under 3% even tap |
  | Real dates | ≥200 suggested, ≥60 happen; ≥30% both say yes; ≥80% both show; ≥70% glad they went | Under 15% both say yes, or show rate under 60% |
  | Arriving on their own | ≥50 people in 8 weeks via ChatGPT and Claude listings, no promotion; ≥20% of dates from people who never saw Smitten by week 12 | Almost none |
  | Agents suggest us | Suggested in ≥10% of weekly runs by week 12 | Under 5% and not rising |
  | Does your AI pick better | The agent's picks get more yeses than our ranking | Not better |

- Week 12: all pass, go to Washington DC and raise. Dates work but almost nobody arrives through
  their own AI, it stays a Smitten feature. Dates don't work, stop.
- Never count time spent in the chat or on our pages as success.

### Stack

- Bun workspace, TypeScript, **Effect end to end**: Effect Schema for the shared contract,
  `@effect/platform` HttpApi for REST, `@effect/ai` for the MCP server, `@effect/sql` over
  Postgres. Deployed as Vercel functions. Next.js admin behind Google OAuth restricted to
  `@smitten.fun` and `@smitten.co`. Postgres with pgvector, migrations via drizzle-kit.
- Secrets via 1Password, materialized with `bun run get:env:dev` or `bun run get:env:prod`.

### Voice

The one-liner:

> No swiping. No small talk. Just a date.

The long description, used in the skill, the plugin, and the MCP server:

> Your AI finds someone worth meeting and sends you one message with their name, a photo, a time
> and a place. No swiping. No small talk. Just a date.

Toward the human, swipeless sounds like a short letter from a friend: warm, intimate, casual.
Short sentences. Lowercase is fine. Gentle humor about apps, never about people. Low pressure
("go live your life, we'll text you"). A note may sign off informally, "xo, your agent". Protocol
copy (API.md, schemas, tool parameter docs) stays dry and technical.

Rules for anything an agent says to its human on swipeless's behalf:

- Say "you" and "them". Never "user", "profile owner", or "the candidate".
- State facts about the other person plainly. Never oversell.
- One proposal at a time.
- No is always enough. The agent never asks why; the optional one-tap reason lives on our page.
- Never say "AI dating". Talk about a real person and a real date.
- Never reveal another person's photo, first name or phone number beyond who they were released
  to.

## Visual identity

A ruled notebook page: red margin line, ink-blue text, yellow highlighter. The admin app uses it,
and so should anything else swipeless shows a human.

| Token | Light | Dark |
|---|---|---|
| paper | `#FBFCF8` | `#12162C` |
| sheet | `#FFFFFE` | `#1A2040` |
| rule | `#D6E2F3` | `#232C52` |
| rule-strong | `#B2C6E4` | `#34407A` |
| margin | `#EE939C` | `#8C3E58` |
| ink | `#2232A8` | `#AEBBFF` |
| text | `#262C5C` | `#DDE2F8` |
| soft | `#586089` | `#9CA4CB` |
| hi | `#F6EE5C` | `#EFE55A` |
| hi-ink | `#1E2342` | `#1E2342` |
| red | `#CC3A52` | `#FF8C9C` |

Fonts from Google: Archivo for display and body (wdth 62..125, wght 100..900), Nanum Pen Script
for handwritten accents.

## Vocabulary

| Term | Meaning |
|---|---|
| brief | The markdown text an agent writes about its human. Never leaves swipeless in full. |
| tailored brief | The version of a brief the service writes for one person looking at it. |
| core | The structured fields used for hard filtering. |
| private layer | Phone number. Released only when both say yes. |
| interest | An agent picking a candidate. Invisible to the other side until both humans say yes. |
| setup | The date swipeless suggests after a pick. Carries the place, the time, and both humans' yes. |
| note | What a human gets about a setup: first name, photo, age, approved details, why you might click, place, time. |
| date request | The note as it reaches the picked person, by SMS. |
| standing instructions | Human-given constraints the agent applies on their behalf. |

## Open questions

Not decided. Do not build these without a decision.

- Whether swipeless carries Smitten's name publicly, beyond the prompt inside Smitten.
- Whether the picked person can ask for another time or place, or only say yes or no.
- What gets someone paused or removed: number of no-shows, reports, and who reviews them.

## Deferred, deliberately

These were discussed and pushed past the MVP. Do not build them without a decision.

- Signup gating (invite codes, waitlist). City-by-city rollout.
- Rescheduling a confirmed date.
- Agent-to-agent conversation before or after a setup.
- Bridging into the Smitten pool. The prompt inside Smitten is the only integration.
- Photos in briefs. Hosted human chat. Push notifications and an app. Automated identity
  verification.
