import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { setups } from '@swipeless/db/schema'
import {
  type Agent,
  CELLO_BRIEF,
  failure,
  man,
  ok,
  profile,
  publish,
} from './support/agent.ts'
import { hasTestDb, openApp, warnSkipped } from './support/app.ts'

/**
 * The setup rules the happy path in date.test.ts does not walk: both agents
 * picking, a no after a yes, repeated answers, and two calls racing for the
 * same row.
 */

warnSkipped('setups.test.ts')

describe.skipIf(!hasTestDb)('setups', () => {
  const app = openApp()
  beforeEach(app.reset)
  afterAll(app.dispose)

  const pair = async (): Promise<readonly [Agent, Agent]> => {
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
    return [sigrun, jon]
  }

  test('when both agents picked, either human may say yes first, and either may still say no', async () => {
    const [sigrun, jon] = await pair()

    const started = ok(await sigrun.pick(jon.profileId)).setup
    const joined = ok(await jon.pick(sigrun.profileId)).setup
    expect(joined.setupId).toBe(started.setupId)
    expect(joined.youPicked).toBe(true)
    expect(joined.status).toBe('suggested')

    // Jón answers first although Sigrún's agent picked first. Saying yes
    // twice is the same yes, and she is told once.
    expect(ok(await jon.confirm(started.setupId)).status).toBe('requested')
    expect(ok(await jon.confirm(started.setupId)).status).toBe('requested')
    expect(app.notifications).toEqual([
      {
        kind: 'dateRequested',
        profileId: sigrun.profileId,
        setupId: started.setupId,
      },
    ])

    // No is always enough, even after the other side said yes, and both
    // see only that the date is not happening.
    expect(ok(await sigrun.decline(started.setupId))).toEqual({
      status: 'declined',
    })
    for (const agent of [sigrun, jon]) {
      const [setup] = ok(await agent.setups()).setups
      expect(setup?.status).toBe('declined')
      expect(setup?.counterpartPrivateLayer).toBeUndefined()
    }

    // Final: nothing reopens it.
    expect(failure(await jon.confirm(started.setupId))).toMatchObject({
      _tag: 'Conflict',
      status: 'declined',
    })
    expect(failure(await jon.decline(started.setupId))).toMatchObject({
      _tag: 'Conflict',
      status: 'declined',
    })
  })

  test('two agents picking each other at once share one setup', async () => {
    const [sigrun, jon] = await pair()

    const [one, two] = await Promise.all([
      sigrun.pick(jon.profileId),
      jon.pick(sigrun.profileId),
    ])
    expect(ok(one).setup.setupId).toBe(ok(two).setup.setupId)

    const rows = await app.query((db) =>
      db.select({ id: setups.id }).from(setups)
    )
    expect(rows).toHaveLength(1)
  })

  test('two humans saying yes at once confirm the date exactly once', async () => {
    const [sigrun, jon] = await pair()
    const { setupId } = ok(await sigrun.pick(jon.profileId)).setup
    ok(await jon.pick(sigrun.profileId))

    const answers = await Promise.all([
      sigrun.confirm(setupId),
      jon.confirm(setupId),
    ])
    // Whoever lost the race sees the other's yes and confirms the date.
    expect(answers.map((one) => ok(one).status).sort()).toEqual([
      'confirmed',
      'requested',
    ])

    for (const agent of [sigrun, jon]) {
      expect(ok(await agent.setups()).setups[0]?.status).toBe('confirmed')
    }
    // The losing yes must not send a second date request.
    const sent = (kind: string) =>
      app.notifications.filter((one) => one.kind === kind)
    expect(sent('dateRequested')).toHaveLength(1)
    expect(sent('dateConfirmed')).toHaveLength(2)
  })

  test('a yes sent twice at once is still one yes', async () => {
    const [sigrun, jon] = await pair()
    const { setupId } = ok(await sigrun.pick(jon.profileId)).setup

    const first = await Promise.all([
      sigrun.confirm(setupId),
      sigrun.confirm(setupId),
    ])
    expect(first.map((one) => ok(one).status)).toEqual([
      'requested',
      'requested',
    ])
    expect(app.notifications).toHaveLength(1)

    const second = await Promise.all([
      jon.confirm(setupId),
      jon.confirm(setupId),
    ])
    expect(second.map((one) => ok(one).status)).toEqual([
      'confirmed',
      'confirmed',
    ])
    expect(
      app.notifications.filter((one) => one.kind === 'dateConfirmed')
    ).toHaveLength(2)
  })
})
