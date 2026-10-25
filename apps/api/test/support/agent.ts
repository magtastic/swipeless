import { expect } from 'bun:test'
import type {
  CandidatesResponse,
  ConfirmResponse,
  DeclineResponse,
  InterestResponse,
  PublishResponse,
  SetupsResponse,
} from '@swipeless/shared'
import type { WebHandler } from './app.ts'

/**
 * An agent as the outside world sees one: it holds a token and talks to the
 * web handler over REST or MCP. Both transports answer in the same shape, so
 * a test reads the same whichever one an agent uses.
 */

export type Transport = 'rest' | 'mcp'

export type Failure = {
  readonly _tag: string
  readonly status?: string
  readonly retryAfterSeconds?: number
}

export type Outcome<A> =
  | { readonly ok: true; readonly value: A }
  | {
      readonly ok: false
      readonly error: Failure
      /** REST only: the status the declared failure mapped to. */
      readonly httpStatus?: number
    }

type Json<T extends { readonly Encoded: unknown }> = T['Encoded']

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

/** A real 1×1 PNG, small enough to inline. */
export const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='

export const HYDROLOGY_BRIEF =
  'She is a hydrologist who reads the weather like other people read faces. ' +
  'She values directness and dislikes being managed. Dealbreaker: calling a ' +
  'car park a hike.'

export const CELLO_BRIEF =
  'He repairs cellos in a basement workshop and cycles everywhere. He values ' +
  'patience and long friendships. Dealbreaker: contempt for slow work.'

export type ProfileArgs = {
  readonly firstName: string
  readonly gender?: 'woman' | 'man' | 'non_binary'
  readonly interestedIn?: ReadonlyArray<'woman' | 'man' | 'non_binary'>
  readonly country?: string
  readonly brief?: string
  readonly phone?: string
  readonly availability?: string
}

/** A woman interested in men in Reykjavík unless told otherwise. */
export const profile = (args: ProfileArgs) => ({
  age: 34,
  gender: args.gender ?? 'woman',
  interestedIn: [...(args.interestedIn ?? ['man'])],
  city: 'Reykjavík',
  country: args.country ?? 'IS',
  radiusKm: 25,
  availability: args.availability ?? 'weekday evenings, sunday afternoons',
  brief: args.brief ?? HYDROLOGY_BRIEF,
  firstName: args.firstName,
  photoUrl: PNG,
  privateLayer: { phone: args.phone ?? '+3548221234' },
})

/** The other side of `profile`'s default: a man interested in women. */
export const man = (args: ProfileArgs) =>
  profile({ gender: 'man', interestedIn: ['woman'], ...args })

/* -------------------------------------------------------------------------- */
/*  Transports                                                                */
/* -------------------------------------------------------------------------- */

export const rest = (
  handler: WebHandler,
  method: string,
  path: string,
  options: { readonly token?: string; readonly body?: unknown } = {}
): Promise<Response> =>
  handler(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(options.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
        ...(options.token === undefined
          ? {}
          : { authorization: `Bearer ${options.token}` }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    })
  )

const restOutcome = async <A>(res: Response): Promise<Outcome<A>> => {
  if (res.status === 204) return { ok: true, value: { deleted: true } as A }
  const body = (await res.json()) as A & Failure
  return res.ok
    ? { ok: true, value: body }
    : { ok: false, error: body, httpStatus: res.status }
}

let rpcId = 1

/** A JSON-RPC call to /mcp. `authorization` is the raw header, if any. */
export const mcp = async (
  handler: WebHandler,
  body: Record<string, unknown>,
  options: { readonly session?: string | null; readonly authorization?: string }
): Promise<Response> =>
  handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(options.session ? { 'mcp-session-id': options.session } : {}),
        ...(options.authorization === undefined
          ? {}
          : { authorization: options.authorization }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, ...body }),
    })
  )

/** Runs the initialize handshake and returns the session id. */
export const initialize = async (
  handler: WebHandler
): Promise<string | null> => {
  const res = await mcp(
    handler,
    {
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    },
    {}
  )
  return res.headers.get('mcp-session-id')
}

/**
 * Calls a tool. A declared failure must arrive as a tool error the agent can
 * read, never as a protocol error, so a protocol error fails the test here.
 */
export const callTool = async <A>(
  handler: WebHandler,
  session: string | null,
  name: string,
  args: Record<string, unknown>,
  authorization?: string
): Promise<Outcome<A>> => {
  const res = await mcp(
    handler,
    { method: 'tools/call', params: { name, arguments: args } },
    { session, authorization }
  )
  // Streamable HTTP answers as JSON or as a single SSE event.
  const text = await res.text()
  const data = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
  const json = JSON.parse(data.length > 0 ? data.join('') : text) as {
    readonly error?: unknown
    readonly result: {
      readonly isError?: boolean
      readonly structuredContent?: unknown
    }
  }
  expect(json.error).toBeUndefined()
  return json.result.isError
    ? { ok: false, error: json.result.structuredContent as Failure }
    : { ok: true, value: json.result.structuredContent as A }
}

/* -------------------------------------------------------------------------- */
/*  The agent                                                                 */
/* -------------------------------------------------------------------------- */

export type Agent = {
  readonly transport: Transport
  readonly profileId: string
  readonly token: string
  readonly candidates: (
    limit?: number
  ) => Promise<Outcome<Json<typeof CandidatesResponse>>>
  readonly pick: (
    profileId: string
  ) => Promise<Outcome<Json<typeof InterestResponse>>>
  readonly confirm: (
    setupId: string
  ) => Promise<Outcome<Json<typeof ConfirmResponse>>>
  readonly decline: (
    setupId: string
  ) => Promise<Outcome<Json<typeof DeclineResponse>>>
  readonly setups: () => Promise<Outcome<Json<typeof SetupsResponse>>>
  readonly remove: () => Promise<Outcome<{ readonly deleted: true }>>
}

/** Publishes a profile and hands back an agent holding its token. */
export const publish = async (
  handler: WebHandler,
  transport: Transport,
  args: ReturnType<typeof profile>
): Promise<Agent> => {
  const session = transport === 'mcp' ? await initialize(handler) : null

  const published = ok(
    transport === 'mcp'
      ? await callTool<Json<typeof PublishResponse>>(
          handler,
          session,
          'swipeless_publish',
          args
        )
      : await restOutcome<Json<typeof PublishResponse>>(
          await rest(handler, 'POST', '/publish', { body: args })
        )
  )
  const { token } = published

  const call = <A>(
    tool: string,
    toolArgs: Record<string, unknown>,
    method: string,
    path: string,
    body?: unknown
  ): Promise<Outcome<A>> =>
    transport === 'mcp'
      ? callTool<A>(handler, session, tool, toolArgs, `Bearer ${token}`)
      : rest(handler, method, path, { token, body }).then(restOutcome<A>)

  return {
    transport,
    profileId: published.profileId,
    token,
    candidates: (limit) =>
      call(
        'swipeless_candidates',
        limit === undefined ? {} : { limit },
        'GET',
        limit === undefined ? '/candidates' : `/candidates?limit=${limit}`
      ),
    pick: (profileId) =>
      call('swipeless_interest', { profileId }, 'POST', '/interest', {
        profileId,
      }),
    confirm: (setupId) =>
      call('swipeless_confirm', { setupId }, 'POST', '/confirm', { setupId }),
    decline: (setupId) =>
      call('swipeless_decline', { setupId }, 'POST', '/decline', { setupId }),
    setups: () => call('swipeless_setups', {}, 'GET', '/setups'),
    remove: () => call('swipeless_delete', {}, 'DELETE', '/profile'),
  }
}

/** The value of a call that has to succeed, failing the test otherwise. */
export const ok = <A>(outcome: Outcome<A>): A => {
  if (!outcome.ok) {
    throw new Error(`expected success, got ${JSON.stringify(outcome)}`)
  }
  return outcome.value
}

/** The failure of a call that has to fail, failing the test otherwise. */
export const failure = <A>(outcome: Outcome<A>): Failure => {
  if (outcome.ok) {
    throw new Error(`expected failure, got ${JSON.stringify(outcome.value)}`)
  }
  return outcome.error
}

/** Profile ids of a candidates answer, in rank order. */
export const ids = (
  outcome: Outcome<{
    readonly candidates: ReadonlyArray<{ readonly profileId: string }>
  }>
): ReadonlyArray<string> => ok(outcome).candidates.map((one) => one.profileId)
