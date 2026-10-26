import { HttpApiSchema } from '@effect/platform'
import { Schema } from 'effect'

/**
 * The swipeless API contract.
 *
 * Every schema here is shared by the HttpApi endpoints, the MCP tools and the
 * database layer, so it is the single source of truth for what an agent may
 * say about its human and what the service says back.
 */

/* -------------------------------------------------------------------------- */
/*  Primitives                                                                */
/* -------------------------------------------------------------------------- */

export const GENDERS = ['man', 'woman', 'non_binary'] as const

export const Gender = Schema.Literal(...GENDERS).annotations({
  identifier: 'Gender',
})
export type Gender = typeof Gender.Type

/**
 * PRODUCT.md, The setup and the date: an agent's pick creates a setup with a
 * date swipeless suggests. `suggested` waits on the picking human's yes and is
 * visible only to the side that picked. `requested` means one human said yes
 * and the date request is with the other. `confirmed` means both said yes.
 */
export const SETUP_STATUSES = [
  'suggested',
  'requested',
  'confirmed',
  'declined',
  'expired',
] as const

export const SetupStatus = Schema.Literal(...SETUP_STATUSES).annotations({
  identifier: 'SetupStatus',
})
export type SetupStatus = typeof SetupStatus.Type

/** ISO-3166-1 alpha-2, uppercase. */
export const CountryCode = Schema.String.pipe(
  Schema.pattern(/^[A-Z]{2}$/)
).annotations({
  identifier: 'CountryCode',
  description: 'ISO-3166-1 alpha-2 country code, uppercase, e.g. IS',
})

export const PhoneNumber = Schema.String.pipe(
  Schema.pattern(/^\+[1-9]\d{6,14}$/)
).annotations({
  identifier: 'PhoneNumber',
  description: 'E.164 phone number, e.g. +3548221234',
})

export const ProfileId = Schema.UUID.annotations({ identifier: 'ProfileId' })
export type ProfileId = typeof ProfileId.Type

export const SetupId = Schema.UUID.annotations({ identifier: 'SetupId' })
export type SetupId = typeof SetupId.Type

/** ISO-8601 instant, e.g. 2026-09-18T19:30:00Z. */
export const Timestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/)
).annotations({ identifier: 'Timestamp' })

export const BRIEF_MAX_LENGTH = 6000

/**
 * A third-person portrait written by the agent, in markdown.
 *
 * By convention it covers, in order: who they are / how they live / what they
 * value / what they want / dealbreakers. Only the length is enforced.
 */
export const Brief = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(BRIEF_MAX_LENGTH)
).annotations({ identifier: 'Brief' })

/* -------------------------------------------------------------------------- */
/*  Profile                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The structured, filterable facts about a human. Shared by ProfileCore and
 * CandidateCore, which differ only in whether radiusKm is present.
 */
const coreFields = {
  age: Schema.Int.pipe(Schema.between(18, 99)),
  gender: Gender,
  interestedIn: Schema.NonEmptyArray(Gender),
  city: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  country: CountryCode,
  /** Free text, short: "weekday evenings, sunday afternoons". */
  availability: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
}

export class ProfileCore extends Schema.Class<ProfileCore>('ProfileCore')({
  ...coreFields,
  radiusKm: Schema.optionalWith(Schema.Int.pipe(Schema.between(1, 500)), {
    default: () => 25,
  }),
}) {}

export const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const

/**
 * Only `approved` profiles are matched. Publish creates them `approved`,
 * departing from PRODUCT.md, Identity ("A person checks every profile before
 * it goes live"); `pending` and the admin queue remain for going back.
 */
export const ReviewStatus = Schema.Literal(...REVIEW_STATUSES).annotations({
  identifier: 'ReviewStatus',
})
export type ReviewStatus = typeof ReviewStatus.Type

/** What another agent gets to see: no radius, no name, photo or phone. */
export class CandidateCore extends Schema.Class<CandidateCore>('CandidateCore')(
  coreFields
) {}

export const FirstName = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(80)
).annotations({ identifier: 'FirstName' })

export const MAX_PHOTO_BYTES = 1024 * 1024

const INLINE_PHOTO =
  /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/
const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** The first `count` bytes a base64 string decodes to. */
const leadingBytes = (base64: string, count: number): Array<number> => {
  const bytes: Array<number> = []
  let buffer = 0
  let bits = 0
  for (const char of base64) {
    const value = BASE64.indexOf(char)
    if (value < 0 || bytes.length === count) break
    buffer = ((buffer << 6) | value) & 0xffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return bytes
}

const startsWith = (
  bytes: ReadonlyArray<number>,
  at: number,
  expected: ReadonlyArray<number>
): boolean => expected.every((byte, index) => bytes[at + index] === byte)

/** "RIFF" and "WEBP" in ASCII. */
const RIFF = [0x52, 0x49, 0x46, 0x46]
const WEBP = [0x57, 0x45, 0x42, 0x50]

/**
 * Why an inline photo is not a real JPEG, PNG or WebP of at most 1 MiB, or
 * undefined when it is one, or is not inline at all. The type in the data URI
 * must match the file's own signature, so a renamed text file is refused at
 * the contract rather than failing later, inside storage.
 */
export const inlinePhotoProblem = (value: string): string | undefined => {
  const match = INLINE_PHOTO.exec(value)
  const type = match?.[1]
  const base64 = match?.[2]
  if (type === undefined || base64 === undefined) return undefined

  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const size = (base64.length / 4) * 3 - padding
  if (base64.length % 4 !== 0 || size < 12) return 'Photo is not a valid image'
  if (size > MAX_PHOTO_BYTES) return 'Photo exceeds 1 MiB'

  const head = leadingBytes(base64, 12)
  const matches =
    type === 'jpeg'
      ? startsWith(head, 0, [0xff, 0xd8, 0xff])
      : type === 'png'
        ? startsWith(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        : startsWith(head, 0, RIFF) && startsWith(head, 8, WEBP)
  return matches ? undefined : 'Photo contents do not match its image type'
}

/** An HTTPS URL, or an inline image a publish uploads to private storage. */
export const PhotoUrl = Schema.String.pipe(
  Schema.maxLength(1400000),
  Schema.pattern(
    /^(https:\/\/[^\s]+|data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2})$/
  ),
  Schema.filter(inlinePhotoProblem)
).annotations({ identifier: 'PhotoUrl' })

/**
 * A file ChatGPT hands a tool whose descriptor lists the field in
 * `_meta["openai/fileParams"]`: the photo a person dropped into the chat.
 * ChatGPT always sends `download_url` and `file_id`; the other two may be
 * missing. MCP only, and only ChatGPT sends it (docs/decisions.md, 2026-10-26).
 */
export const UploadedFile = Schema.Struct({
  download_url: Schema.String,
  file_id: Schema.String,
  mime_type: Schema.optional(Schema.String),
  file_name: Schema.optional(Schema.String),
})
export type UploadedFile = typeof UploadedFile.Type

/**
 * The JSON Schema ChatGPT requires of a file parameter: an object declaring
 * all four properties, requiring exactly `download_url` and `file_id`.
 */
const UPLOADED_FILE_JSON_SCHEMA = {
  type: 'object',
  description:
    'The photo the person dropped into this chat. ChatGPT fills this in.',
  properties: {
    download_url: { type: 'string' },
    file_id: { type: 'string' },
    mime_type: { type: 'string' },
    file_name: { type: 'string' },
  },
  required: ['download_url', 'file_id'],
} as const

/**
 * The `photo` argument of swipeless_publish. Advertised as the file object
 * alone, since ChatGPT rejects any other schema for a file parameter, but a
 * string is accepted too: ChatGPT on mobile sometimes sends a bare
 * "chat_upload" instead of the object, and that has to come back as a photo
 * problem the agent can act on, not a schema error.
 */
export const PhotoUpload = Schema.Union(
  UploadedFile,
  Schema.String
).annotations({ jsonSchema: UPLOADED_FILE_JSON_SCHEMA })

/** Withheld until both humans say yes to a date. */
export class PrivateLayer extends Schema.Class<PrivateLayer>('PrivateLayer')({
  phone: PhoneNumber,
}) {}

export class Profile extends ProfileCore.extend<Profile>('Profile')({
  brief: Brief,
  /** Shown in the note, to the one person a date is with. */
  firstName: FirstName,
  /** Required to publish. Shown in the note, never to candidates. */
  photoUrl: PhotoUrl,
  privateLayer: PrivateLayer,
  email: Schema.optional(Schema.String),
  /** Agent-steering, e.g. "no weekdays", "never propose bars". */
  standingInstructions: Schema.optional(
    Schema.String.pipe(Schema.maxLength(1000))
  ),
}) {}

export class Candidate extends Schema.Class<Candidate>('Candidate')({
  profileId: ProfileId,
  core: CandidateCore,
  brief: Brief,
  score: Schema.Number.pipe(Schema.between(0, 1)),
}) {}

/* -------------------------------------------------------------------------- */
/*  Setups                                                                    */
/* -------------------------------------------------------------------------- */

export class Venue extends Schema.Class<Venue>('Venue')({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  address: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(400)),
}) {}

/** The first date swipeless suggests for both people: a public place and a time. */
export class DateSuggestion extends Schema.Class<DateSuggestion>(
  'DateSuggestion'
)({
  venue: Venue,
  time: Timestamp,
}) {}

/**
 * What the note shows about the other person. Released to a side as soon as
 * it can see the setup. The photo URL is signed and short-lived.
 */
export class Counterpart extends Schema.Class<Counterpart>('Counterpart')({
  profileId: ProfileId,
  firstName: FirstName,
  age: Schema.Int,
  photoUrl: Schema.String,
  /**
   * The counterpart's stored brief, the same text candidates get, so the
   * picked person's agent can write the note. A brief tailored to the person
   * looking replaces it later (PRODUCT.md, Matching).
   */
  brief: Brief,
}) {}

export class Setup extends Schema.Class<Setup>('Setup')({
  setupId: SetupId,
  counterpart: Counterpart,
  status: SetupStatus,
  date: DateSuggestion,
  /** Whether the caller's agent made the pick that started this setup. */
  youPicked: Schema.Boolean,
  /** Whether the caller's human said yes. The other side's flag is not exposed. */
  youConfirmed: Schema.Boolean,
  /**
   * The counterpart's private layer, present only once both said yes.
   * Listing setups is how an agent recovers it after the confirm call.
   */
  counterpartPrivateLayer: Schema.optional(PrivateLayer),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  expiresAt: Timestamp,
}) {}

/* -------------------------------------------------------------------------- */
/*  Requests                                                                  */
/* -------------------------------------------------------------------------- */

export const PublishRequest = Profile
export type PublishRequest = Profile

export class CandidatesQuery extends Schema.Class<CandidatesQuery>(
  'CandidatesQuery'
)({
  limit: Schema.optionalWith(
    Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 10)),
    { default: () => 10 }
  ),
}) {}

export class InterestRequest extends Schema.Class<InterestRequest>(
  'InterestRequest'
)({
  profileId: ProfileId,
}) {}

/** The caller's human said yes to the suggested date. */
export class ConfirmRequest extends Schema.Class<ConfirmRequest>(
  'ConfirmRequest'
)({
  setupId: SetupId,
}) {}

/**
 * Declining takes the setup and nothing else. PRODUCT.md, Voice: "No is
 * always enough. Never ask why." — so there is no reason to carry.
 */
export class DeclineRequest extends Schema.Class<DeclineRequest>(
  'DeclineRequest'
)({
  setupId: SetupId,
}) {}

/* -------------------------------------------------------------------------- */
/*  Responses                                                                 */
/* -------------------------------------------------------------------------- */

export class HealthResponse extends Schema.Class<HealthResponse>(
  'HealthResponse'
)({
  ok: Schema.Literal(true),
}) {}

export class PublishResponse extends Schema.Class<PublishResponse>(
  'PublishResponse'
)({
  profileId: ProfileId,
  /**
   * Opaque bearer token. Shown once, at publish. Store it; it authenticates
   * every later call and is the only way to delete the profile.
   */
  token: Schema.String.pipe(Schema.minLength(1)),
  /** What the agent tells its human now, and that it does nothing else yet. */
  next: Schema.String,
}) {}

export class CandidatesResponse extends Schema.Class<CandidatesResponse>(
  'CandidatesResponse'
)({
  candidates: Schema.Array(Candidate),
}) {}

/** A pick answers with the whole setup, so the agent can show the note at once. */
export class InterestResponse extends Schema.Class<InterestResponse>(
  'InterestResponse'
)({
  setup: Setup,
}) {}

export class ConfirmResponse extends Schema.Class<ConfirmResponse>(
  'ConfirmResponse'
)({
  status: SetupStatus,
  /** Released only once both humans have said yes. */
  privateLayer: Schema.optional(PrivateLayer),
}) {}

/** Always `declined`: the call either settles the setup or fails. */
export class DeclineResponse extends Schema.Class<DeclineResponse>(
  'DeclineResponse'
)({
  status: SetupStatus,
}) {}

export class SetupsResponse extends Schema.Class<SetupsResponse>(
  'SetupsResponse'
)({
  setups: Schema.Array(Setup),
}) {}

/* -------------------------------------------------------------------------- */
/*  Errors                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every declared error carries its HTTP status here, where the error is
 * defined, so REST and MCP cannot disagree about what a failure means. The
 * adapters consume the unions below and never re-annotate.
 *
 * 400 comes free from schema validation; these are the rest.
 */

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  'Unauthorized',
  {},
  HttpApiSchema.annotations<Unauthorized>({ status: 401 })
) {}

/** Unknown setup or profile. */
export class NotFound extends Schema.TaggedError<NotFound>()(
  'NotFound',
  {},
  HttpApiSchema.annotations<NotFound>({ status: 404 })
) {}

/** The action is not valid for the setup's current status, e.g. a yes after a no. */
export class Conflict extends Schema.TaggedError<Conflict>()(
  'Conflict',
  { status: SetupStatus },
  HttpApiSchema.annotations<Conflict>({ status: 409 })
) {}

/** The profile expired: 90 days without a check-in. */
export class Gone extends Schema.TaggedError<Gone>()(
  'Gone',
  {},
  HttpApiSchema.annotations<Gone>({ status: 410 })
) {}

/** Weekly interest cap reached. */
export class RateLimited extends Schema.TaggedError<RateLimited>()(
  'RateLimited',
  { retryAfterSeconds: Schema.Int },
  HttpApiSchema.annotations<RateLimited>({ status: 429 })
) {}

/**
 * The photo could not be used: an upload that could not be fetched, was not a
 * JPEG, PNG or WebP, or was too large. The message says what to ask for.
 */
export class BadPhoto extends Schema.TaggedError<BadPhoto>()(
  'BadPhoto',
  { message: Schema.String },
  HttpApiSchema.annotations<BadPhoto>({ status: 400 })
) {}

/* -------------------------------------------------------------------------- */
/*  Failure unions, one per operation                                         */
/* -------------------------------------------------------------------------- */

/**
 * Resolving the bearer token can fail two ways, and every authenticated
 * operation inherits both. This is what the REST middleware declares.
 */
export const AuthError = Schema.Union(Unauthorized, Gone)
export type AuthError = typeof AuthError.Type

/**
 * Publishing is open signup, so nothing about it is a declared failure: a bad
 * body is a 400 from schema validation, and an embedding or database outage is
 * a defect, not something an agent can act on.
 */
export const PublishError = Schema.Never
export type PublishError = typeof PublishError.Type

/**
 * Over MCP, a photo uploaded in ChatGPT is fetched while publishing, and that
 * fetch can fail in ways the agent can fix by asking for another photo.
 */
export const PublishUploadError = BadPhoto
export type PublishUploadError = BadPhoto

export const CandidatesError = AuthError
export type CandidatesError = AuthError

export const DeleteError = AuthError
export type DeleteError = AuthError

export const SetupsError = AuthError
export type SetupsError = AuthError

export const InterestError = Schema.Union(
  Unauthorized,
  Gone,
  NotFound,
  RateLimited
)
export type InterestError = typeof InterestError.Type

export const ConfirmError = Schema.Union(Unauthorized, Gone, NotFound, Conflict)
export type ConfirmError = typeof ConfirmError.Type

export const DeclineError = ConfirmError
export type DeclineError = ConfirmError
