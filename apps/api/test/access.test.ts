import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { profiles } from '@swipeless/db/schema'
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

  test('an MCP host that cannot set a header passes the token as a parameter', async () => {
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
    // A ChatGPT connector: no Authorization header on any call.
    const session = await initialize(app.handler)
    const as = <A>(
      token: string,
      tool: string,
      args: Record<string, unknown> = {}
    ) => callTool<A>(app.handler, session, tool, { ...args, token })

    expect(ids(await as(sigrun.token, 'swipeless_candidates'))).toEqual([
      jon.profileId,
    ])
    const { setup } = ok(
      await as<{ setup: { setupId: string } }>(
        sigrun.token,
        'swipeless_interest',
        { profileId: jon.profileId }
      )
    )
    ok(await as(sigrun.token, 'swipeless_confirm', { setupId: setup.setupId }))
    expect(
      ok(
        await as<{ setups: ReadonlyArray<{ setupId: string }> }>(
          jon.token,
          'swipeless_setups'
        )
      ).setups.map((one) => one.setupId)
    ).toEqual([setup.setupId])
    ok(await as(jon.token, 'swipeless_decline', { setupId: setup.setupId }))

    // A wrong token is refused as it is in the header.
    expect(failure(await as('never-issued', 'swipeless_setups'))._tag).toBe(
      'Unauthorized'
    )

    // A header wins over the parameter, even when the header is wrong.
    const both = await callTool(
      app.handler,
      session,
      'swipeless_setups',
      { token: sigrun.token },
      'Bearer never-issued'
    )
    expect(failure(both)._tag).toBe('Unauthorized')

    expect(
      ok(await as<{ deleted: true }>(jon.token, 'swipeless_delete'))
    ).toEqual({
      deleted: true,
    })
    expect(failure(await as(jon.token, 'swipeless_setups'))._tag).toBe(
      'Unauthorized'
    )
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

  test('publish takes no token and refuses an invalid profile or photo', async () => {
    const valid = profile({ firstName: 'Sigrún' })
    const { photoUrl: _, ...withoutPhoto } = valid
    const inline = (type: string, bytes: Uint8Array) =>
      `data:image/${type};base64,${Buffer.from(bytes).toString('base64')}`
    const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const png = (size: number) => {
      const bytes = new Uint8Array(size)
      bytes.set(PNG_SIGNATURE)
      return bytes
    }

    const invalid = [
      { ...valid, age: 17 },
      withoutPhoto,
      // A text file dressed up as an image.
      {
        ...valid,
        photoUrl: inline(
          'png',
          new TextEncoder().encode('not really an image')
        ),
      },
      // A real PNG claiming to be a JPEG.
      { ...valid, photoUrl: inline('jpeg', png(64)) },
      // A real PNG one byte over the limit.
      { ...valid, photoUrl: inline('png', png(1024 * 1024 + 1)) },
    ]

    // Refused as invalid input on both transports: a 400 on REST, a tool
    // error on MCP, never a 500 or a protocol error.
    const session = await initialize(app.handler)
    for (const body of invalid) {
      const res = await rest(app.handler, 'POST', '/publish', { body })
      expect(res.status).toBe(400)
      const tool = await callTool(
        app.handler,
        session,
        'swipeless_publish',
        body
      )
      expect(tool.ok).toBe(false)
    }

    // Nothing was stored by the refusals.
    expect(await app.query((db) => db.select().from(profiles))).toEqual([])
    expect(app.photos.size).toBe(0)

    await publish(app.handler, 'mcp', valid)
    expect(app.photos.size).toBe(1)
  })
})
