import type { ProfileId } from '@swipeless/shared'
import { DateSuggestion, Venue } from '@swipeless/shared'
import { Clock, Context, Effect, Layer } from 'effect'

/**
 * PRODUCT.md, The setup and the date: "swipeless suggests a first date made
 * for both people: a public place and a time that fits both availabilities."
 *
 * The seam is the whole of that sentence. `SetupLifecycle` asks it once, at
 * the pick, and stores the answer on the setup; it never looks inside.
 *
 * The live adapter below is deterministic and rule-based, enough for the demo:
 * a short curated list of real public cafés per city and the earliest
 * Thursday evening or Saturday afternoon both availabilities allow. A model that reads both briefs replaces it
 * later, behind this same interface.
 */

/** What the suggester may know about one side: the core, never the brief. */
export interface DateParty {
  readonly profileId: ProfileId
  readonly city: string
  readonly country: string
  readonly availability: string
}

export class DateSuggester extends Context.Tag('DateSuggester')<
  DateSuggester,
  {
    /** `a` is the side whose agent picked, `b` the side it picked. */
    readonly suggest: (pair: {
      readonly a: DateParty
      readonly b: DateParty
    }) => Effect.Effect<DateSuggestion>
  }
>() {}

/* -------------------------------------------------------------------------- */
/*  The rule-based adapter                                                    */
/* -------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000

/** PRODUCT.md asks for a time that leaves room to say yes; two days is ours. */
const LEAD_MS = 2 * DAY_MS

type Slot = {
  readonly weekday: number
  readonly hour: number
  readonly minute: number
}

/** Thursday 19:30, coffee and a walk after work. */
const THURSDAY_EVENING: Slot = { weekday: 4, hour: 19, minute: 30 }
/** Saturday 15:00, the low-pressure weekend option. */
const SATURDAY_AFTERNOON: Slot = { weekday: 6, hour: 15, minute: 0 }

/**
 * Real, public, well-known places, keyed by `country:city` with the city
 * lowercased and stripped of accents, so "Reykjavík" and "reykjavik" agree.
 */
const VENUES: Readonly<Record<string, ReadonlyArray<Venue>>> = {
  'IS:reykjavik': [
    new Venue({
      name: 'Reykjavík Roasters',
      address: 'Kárastígur 1, 101 Reykjavík',
    }),
    new Venue({
      name: 'Mokka Kaffi',
      address: 'Skólavörðustígur 3a, 101 Reykjavík',
    }),
    new Venue({
      name: 'Kaffihús Vesturbæjar',
      address: 'Melhagi 20, 107 Reykjavík',
    }),
    new Venue({
      name: 'Café Babalú',
      address: 'Skólavörðustígur 22a, 101 Reykjavík',
    }),
  ],
}

/**
 * Wall-clock offset from UTC in minutes, per country. Iceland keeps
 * Atlantic/Reykjavik, which is UTC+0 all year with no daylight saving, and
 * everywhere else is UTC for the demo.
 */
const UTC_OFFSET_MINUTES: Readonly<Record<string, number>> = { IS: 0 }

const cityKey = (country: string, city: string): string =>
  `${country.toUpperCase()}:${city
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()}`

/** A small stable hash, so the same pair always gets the same café. */
const stableIndex = (text: string, modulo: number): number => {
  let hash = 0
  for (const char of text) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) | 0
  return Math.abs(hash) % modulo
}

/** The first occurrence of `slot` in local time that is at or after `from`. */
const nextSlot = (slot: Slot, from: number, offsetMinutes: number): number => {
  const offsetMs = offsetMinutes * 60 * 1000
  const local = new Date(from + offsetMs)
  const candidate = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + ((slot.weekday - local.getUTCDay() + 7) % 7),
    slot.hour,
    slot.minute
  )
  const at = candidate - offsetMs
  return at >= from ? at : at + 7 * DAY_MS
}

const WEEKEND = /weekend|saturday|laugardag|helg/i
const EVENING = /weekday|evening|thursday|after work|kvöld/i

/** The slots this side's availability says it can make, possibly none. */
const supportedSlots = (party: DateParty): ReadonlyArray<Slot> => [
  ...(EVENING.test(party.availability) ? [THURSDAY_EVENING] : []),
  ...(WEEKEND.test(party.availability) ? [SATURDAY_AFTERNOON] : []),
]

/**
 * PRODUCT.md, The setup and the date: "a time that fits both
 * availabilities". The slots both sides can make; empty when they share
 * none, or when either side's text names nothing the rules recognise.
 */
const sharedSlots = (a: DateParty, b: DateParty): ReadonlyArray<Slot> => {
  const theirs = supportedSlots(b)
  return supportedSlots(a).filter((slot) => theirs.includes(slot))
}

/**
 * With no slot both sides can make, Thursday evening, coffee and a walk
 * after work. A deliberate guess, not a fit: a model that reads both
 * availabilities replaces this rule later, behind the same interface.
 */
const FALLBACK_SLOT: Slot = THURSDAY_EVENING

/** Where the date happens: a curated café in either city, else a generic one. */
const pickVenue = (a: DateParty, b: DateParty): Venue => {
  const seed = [a.profileId, b.profileId].sort().join(':')
  for (const party of [a, b]) {
    const venues = VENUES[cityKey(party.country, party.city)] ?? []
    const venue = venues[stableIndex(seed, Math.max(1, venues.length))]
    if (venue !== undefined) return venue
  }
  return new Venue({
    name: `A café in the centre of ${a.city}`,
    address: `City centre, ${a.city}`,
  })
}

export const DateSuggesterRules = Layer.succeed(
  DateSuggester,
  DateSuggester.of({
    suggest: ({ a, b }) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const from = now + LEAD_MS
        const offset = UTC_OFFSET_MINUTES[a.country.toUpperCase()] ?? 0
        const shared = sharedSlots(a, b)
        // The earliest shared slot at least the lead time away.
        const at =
          shared.length === 0
            ? nextSlot(FALLBACK_SLOT, from, offset)
            : Math.min(...shared.map((slot) => nextSlot(slot, from, offset)))

        return new DateSuggestion({
          venue: pickVenue(a, b),
          time: new Date(at).toISOString(),
        })
      }),
  })
)
