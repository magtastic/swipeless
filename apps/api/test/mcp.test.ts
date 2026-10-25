import { afterAll, describe, expect, test } from 'bun:test'
import {
  CandidatesResponse,
  DeclineResponse,
  NotFound,
} from '@swipeless/shared'
import { Effect } from 'effect'
import { disposeHandlers, openHandler } from './support/app-handler.ts'
import { GONE_TOKEN, GOOD_TOKEN, UNKNOWN_TOKEN } from './support/fake-caller.ts'
import {
  FAKE_PROFILE_ID,
  FAKE_SETUP_ID,
  fakeApp,
} from './support/fake-swipeless.ts'
import { callTool, initialize, readRpc, rpc } from './support/mcp-client.ts'

/**
 * MCP is the primary interface, so the tool list is part of the contract and a
 * declared failure has to arrive as a tool error the agent can read, not as a
 * protocol error that looks like the server is broken.
 */

afterAll(disposeHandlers)

const TOOLS = [
  'swipeless_publish',
  'swipeless_candidates',
  'swipeless_interest',
  'swipeless_confirm',
  'swipeless_decline',
  'swipeless_setups',
  'swipeless_delete',
]

const VALID_PROFILE = {
  age: 34,
  gender: 'woman',
  interestedIn: ['man'],
  city: 'Reykjavík',
  country: 'IS',
  radiusKm: 25,
  availability: 'weekday evenings',
  brief:
    'She is a hydrologist who reads the weather like other people read faces. ' +
    'She values directness and dislikes being managed. Dealbreaker: anyone ' +
    'who calls hiking a hobby and means a car park.',
  firstName: 'Sigrún',
  photoUrl: 'https://example.invalid/sigrun.jpg',
  privateLayer: { phone: '+3548221234' },
}

describe('MCP /mcp', () => {
  test('lists the seven swipeless tools', async () => {
    const handler = openHandler(fakeApp())
    const session = await initialize(handler)

    const res = await rpc(
      handler,
      { method: 'tools/list', params: {} },
      { session }
    )
    expect(res.status).toBe(200)
    const json = (await readRpc(res)) as {
      result: { tools: { name: string }[] }
    }
    expect(json.result.tools.map((t) => t.name).sort()).toEqual(
      [...TOOLS].sort()
    )
  })

  test('no tool description says AI dating', async () => {
    const handler = openHandler(fakeApp())
    const session = await initialize(handler)

    const res = await rpc(
      handler,
      { method: 'tools/list', params: {} },
      { session }
    )
    const json = (await readRpc(res)) as {
      result: { tools: { name: string; description: string }[] }
    }
    for (const tool of json.result.tools) {
      expect(tool.description.toLowerCase()).not.toContain('ai dating')
    }
    const publish = json.result.tools.find(
      (tool) => tool.name === 'swipeless_publish'
    )
    expect(publish?.description).toContain('find them a date')
  })

  test('a declared failure comes back as a tool error, not a protocol error', async () => {
    const handler = openHandler(fakeApp({ interest: () => new NotFound() }))
    const session = await initialize(handler)

    const json = await callTool(
      handler,
      'swipeless_interest',
      { profileId: FAKE_PROFILE_ID },
      { session, token: GOOD_TOKEN }
    )

    expect(json.error).toBeUndefined()
    expect(json.result.isError).toBe(true)
    expect(json.result.structuredContent).toMatchObject({ _tag: 'NotFound' })
  })

  test('decline reaches the service and answers with the settled status', async () => {
    const seen: Array<string> = []
    const handler = openHandler(
      fakeApp({
        decline: (_current, request) => {
          seen.push(request.setupId)
          return Effect.succeed(new DeclineResponse({ status: 'declined' }))
        },
      })
    )
    const session = await initialize(handler)

    const json = await callTool(
      handler,
      'swipeless_decline',
      { setupId: FAKE_SETUP_ID },
      { session, token: GOOD_TOKEN }
    )

    expect(json.result.isError).toBeFalsy()
    expect(json.result.structuredContent).toMatchObject({ status: 'declined' })
    expect(seen).toEqual([FAKE_SETUP_ID])
  })
})

/**
 * The reason the MCP adapter reads the header per call instead of resolving a
 * profile when the layer is built: one server, many agents, and a token that
 * can go stale mid-session.
 */
describe('MCP authentication is per call', () => {
  const call = async (token: string | undefined) => {
    const handler = openHandler(fakeApp())
    const session = await initialize(handler)
    return callTool(handler, 'swipeless_setups', {}, { session, token })
  }

  test('an authenticated tool without a token is a typed Unauthorized', async () => {
    const json = await call(undefined)

    expect(json.error).toBeUndefined()
    expect(json.result.isError).toBe(true)
    expect(json.result.structuredContent).toMatchObject({
      _tag: 'Unauthorized',
    })
  })

  test('an unknown token is Unauthorized', async () => {
    const json = await call(UNKNOWN_TOKEN)

    expect(json.result.isError).toBe(true)
    expect(json.result.structuredContent).toMatchObject({
      _tag: 'Unauthorized',
    })
  })

  test('an expired profile is Gone, so the agent knows to republish', async () => {
    const json = await call(GONE_TOKEN)

    expect(json.result.isError).toBe(true)
    expect(json.result.structuredContent).toMatchObject({ _tag: 'Gone' })
  })

  test('a good token reaches the service as the profile it resolves to', async () => {
    const seen: Array<string> = []
    const handler = openHandler(
      fakeApp({
        candidates: (current) => {
          seen.push(current.profileId)
          return Effect.succeed(new CandidatesResponse({ candidates: [] }))
        },
      })
    )
    const session = await initialize(handler)

    const json = await callTool(
      handler,
      'swipeless_candidates',
      { limit: 3 },
      { session, token: GOOD_TOKEN }
    )

    expect(json.result.isError).toBeFalsy()
    expect(seen).toEqual([FAKE_PROFILE_ID])
  })

  test('publish needs no token: it is how an agent gets one', async () => {
    const handler = openHandler(fakeApp())
    const session = await initialize(handler)

    const json = await callTool(handler, 'swipeless_publish', VALID_PROFILE, {
      session,
    })

    expect(json.result.isError).toBeFalsy()
    expect(json.result.structuredContent).toMatchObject({
      profileId: FAKE_PROFILE_ID,
    })
  })
})
