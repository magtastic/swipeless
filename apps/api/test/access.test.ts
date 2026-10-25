import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Duration } from 'effect'
import {
  CELLO_BRIEF,
  callTool,
  failure,
  ids,
  initialize,
  man,
  ok,
  profile,
  publish,
  rest,
} from './support/agent.ts'
import { hasTestDb, openApp, warnSkipped } from './support/app.ts'

/**
 * Who the caller is, over both transports. The token is the identity, not the
 * connection: one MCP session can serve any number of agents, a profile stays
 * alive by checking in, and a refusal always arrives as something the agent
 * can read — a status on REST, a tool error on MCP.
 */

warnSkipped('access.test.ts')

describe.skipIf(!hasTestDb)('access', () => {
  const app = openApp()
  beforeEach(app.reset)
  afterAll(app.dispose)

  test('one MCP session serves whichever agent holds the token', async () => {
    const sigrun = await publish(
      app.handler,
      'mcp',
      profile({ firstName: 'Sigrún' })
    )
    const jon = await publish(
      app.handler,
      'mcp',
      man({ firstName: 'Jón', brief: CELLO_BRIEF })
    )
    await app.approve(sigrun.profileId, jon.profileId)

    // A third session, shared by both: if MCP resolved the caller once per
    // session, the second agent would be served as the first.
    const shared = await initialize(app.handler)
    const candidatesFor = (token: string) =>
      callTool<{ candidates: ReadonlyArray<{ profileId: string }> }>(
        app.handler,
        shared,
        'swipeless_candidates',
        {},
        `Bearer ${token}`
      )
    expect(ids(await candidatesFor(sigrun.token))).toEqual([jon.profileId])
    expect(ids(await candidatesFor(jon.token))).toEqual([sigrun.profileId])

    // The same token works over REST, whatever the case of the scheme.
    const res = await app.handler(
      new Request('http://localhost/candidates', {
        headers: { authorization: `bearer ${sigrun.token}` },
      })
    )
    expect(res.status).toBe(200)
  })

  test('a missing, malformed or unknown token is Unauthorized on both transports', async () => {
    const sigrun = await publish(
      app.handler,
      'rest',
      profile({ firstName: 'Sigrún' })
    )
    const session = await initialize(app.handler)

    for (const authorization of [
      undefined,
      `Token ${sigrun.token}`,
      `Basic ${sigrun.token}`,
      'Bearer never-issued',
    ]) {
      const res = await app.handler(
        new Request('http://localhost/setups', {
          headers: authorization === undefined ? {} : { authorization },
        })
      )
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ _tag: 'Unauthorized' })

      const tool = await callTool(
        app.handler,
        session,
        'swipeless_setups',
        {},
        authorization
      )
      expect(failure(tool)._tag).toBe('Unauthorized')
    }
  })

  test('checking in keeps a profile alive; ninety quiet days make it Gone', async () => {
    const sigrun = await publish(
      app.handler,
      'mcp',
      profile({ firstName: 'Sigrún' })
    )
    const jon = await publish(
      app.handler,
      'rest',
      man({ firstName: 'Jón', brief: CELLO_BRIEF })
    )
    await app.approve(sigrun.profileId, jon.profileId)

    // Any authenticated call is a check-in that buys another ninety days.
    app.travel(Duration.days(60))
    ok(await sigrun.setups())
    app.travel(Duration.days(60))
    expect(ok(await sigrun.setups()).setups).toEqual([])

    // Jón has been quiet for 120 days: out of the pool, and told so, so his
    // agent knows to republish rather than hunt for a lost token.
    expect(ids(await sigrun.candidates())).toEqual([])
    expect(failure(await sigrun.pick(jon.profileId))._tag).toBe('NotFound')
    const gone = await jon.setups()
    expect(gone).toMatchObject({ ok: false, httpStatus: 410 })
    expect(failure(gone)._tag).toBe('Gone')

    app.travel(Duration.days(91))
    expect(failure(await sigrun.setups())._tag).toBe('Gone')
  })

  test('publish takes no token and refuses an invalid profile', async () => {
    const valid = profile({ firstName: 'Sigrún' })
    const { photoUrl: _, ...withoutPhoto } = valid

    for (const body of [{ ...valid, age: 17 }, withoutPhoto]) {
      const res = await rest(app.handler, 'POST', '/publish', { body })
      expect(res.status).toBe(400)
    }

    const session = await initialize(app.handler)
    const tool = await callTool(app.handler, session, 'swipeless_publish', {
      ...valid,
      age: 17,
    })
    expect(tool.ok).toBe(false)

    // Nothing half-written was left behind by the refusals.
    const fresh = await publish(app.handler, 'rest', valid)
    await app.approve(fresh.profileId)
    expect(app.photos.size).toBe(1)
  })
})
