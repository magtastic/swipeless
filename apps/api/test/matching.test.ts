import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Duration } from 'effect'
import {
  CELLO_BRIEF,
  failure,
  ids,
  man,
  ok,
  profile,
  publish,
} from './support/agent.ts'
import { hasTestDb, openApp, warnSkipped } from './support/app.ts'

/**
 * Who an agent is shown and who it may pick: the hard filters, the ranking,
 * the difference between a no and an expiry, and the weekly ceiling.
 */

warnSkipped('matching.test.ts')

describe.skipIf(!hasTestDb)('matching', () => {
  const app = openApp()
  beforeEach(app.reset)
  afterAll(app.dispose)

  test('candidates pass every hard filter and rank by brief, best first', async () => {
    const join = (args: Parameters<typeof profile>[0]) =>
      publish(app.handler, 'rest', profile(args))

    // Quiet for ninety days by the time anyone asks.
    const stale = await join({
      firstName: 'Ari',
      gender: 'man',
      interestedIn: ['woman'],
    })
    app.travel(Duration.days(91))

    const sigrun = await join({ firstName: 'Sigrún' })
    // Byte-identical brief, so the closest possible match.
    const twin = await join({
      firstName: 'Jón',
      gender: 'man',
      interestedIn: ['woman'],
    })
    const other = await join({
      firstName: 'Einar',
      gender: 'man',
      interestedIn: ['woman'],
      brief: CELLO_BRIEF,
    })
    const excluded = await Promise.all([
      // Sigrún is not interested in women.
      join({ firstName: 'Halla', gender: 'woman', interestedIn: ['woman'] }),
      // Not interested in Sigrún's gender.
      join({ firstName: 'Björn', gender: 'man', interestedIn: ['man'] }),
      // Another country.
      join({
        firstName: 'Tom',
        gender: 'man',
        interestedIn: ['woman'],
        country: 'GB',
      }),
    ])
    const ranked = ok(await sigrun.candidates()).candidates
    expect(ranked.map((one) => one.profileId)).toEqual([
      twin.profileId,
      other.profileId,
    ])
    expect(ranked[0]?.score).toBeCloseTo(1, 5)
    expect(ranked[1]?.score).toBeLessThan(ranked[0]?.score ?? 0)
    expect(ids(await sigrun.candidates(1))).toEqual([twin.profileId])

    // A pick is held to the same pool.
    for (const target of [sigrun, stale]) {
      expect(failure(await sigrun.pick(target.profileId))._tag).toBe('NotFound')
    }
    expect(
      failure(await sigrun.pick('00000000-0000-4000-8000-000000000000'))._tag
    ).toBe('NotFound')
  })

  test('a no closes a pair for good; an expired date lets them meet again', async () => {
    const sigrun = await publish(
      app.handler,
      'mcp',
      profile({ firstName: 'Sigrún' })
    )
    const jon = await publish(app.handler, 'rest', man({ firstName: 'Jón' }))
    const einar = await publish(
      app.handler,
      'rest',
      man({ firstName: 'Einar', brief: CELLO_BRIEF })
    )
    // Picked pairs leave each other's candidates while the setup is open.
    const withJon = ok(await sigrun.pick(jon.profileId)).setup
    const withEinar = ok(await sigrun.pick(einar.profileId)).setup
    expect(ids(await sigrun.candidates())).toEqual([])
    expect(ids(await jon.candidates())).toEqual([])

    // Sigrún says no to Jón. He never learns he was picked, and the two are
    // never shown to each other again, whoever asks.
    expect(ok(await sigrun.decline(withJon.setupId))).toEqual({
      status: 'declined',
    })
    expect(ok(await jon.setups()).setups).toEqual([])
    expect(failure(await jon.pick(sigrun.profileId))._tag).toBe('NotFound')
    expect(failure(await sigrun.pick(jon.profileId))._tag).toBe('NotFound')

    // Nobody answers the date with Einar before its time passes.
    app.travel(Duration.days(3))
    const [expired] = ok(await sigrun.setups()).setups.filter(
      (one) => one.setupId === withEinar.setupId
    )
    expect(expired?.status).toBe('expired')
    expect(failure(await sigrun.confirm(withEinar.setupId))).toMatchObject({
      _tag: 'Conflict',
      status: 'expired',
    })
    expect(failure(await sigrun.decline(withEinar.setupId))).toMatchObject({
      _tag: 'Conflict',
      status: 'expired',
    })

    // Expiry is not a no: Einar is back, Jón is not, and a fresh pick
    // starts a new setup with a new date.
    expect(ids(await sigrun.candidates())).toEqual([einar.profileId])
    const again = ok(await sigrun.pick(einar.profileId)).setup
    expect(again.setupId).not.toBe(withEinar.setupId)
    expect(again.status).toBe('suggested')
    expect(Date.parse(again.date.time)).toBeGreaterThan(
      Date.parse(withEinar.date.time)
    )
  })
})

describe.skipIf(!hasTestDb)('the weekly ceiling on picks', () => {
  const app = openApp({ weeklyCap: 2 })
  beforeEach(app.reset)
  afterAll(app.dispose)

  test('stops the third pick in a week and says how long to wait', async () => {
    const sigrun = await publish(
      app.handler,
      'rest',
      profile({ firstName: 'Sigrún' })
    )
    const men = await Promise.all(
      ['Jón', 'Ari', 'Einar'].map((firstName) =>
        publish(app.handler, 'mcp', man({ firstName }))
      )
    )
    const [jon, ari, einar] = men as [
      typeof sigrun,
      typeof sigrun,
      typeof sigrun,
    ]

    ok(await sigrun.pick(jon.profileId))
    // Repeating a pick is free.
    ok(await sigrun.pick(jon.profileId))

    app.travel(Duration.days(1))
    // Joining a setup the other side's agent started spends a pick too.
    const started = ok(await ari.pick(sigrun.profileId)).setup
    const joined = ok(await sigrun.pick(ari.profileId)).setup
    expect(joined.setupId).toBe(started.setupId)
    expect(joined.youPicked).toBe(true)

    const capped = await sigrun.pick(einar.profileId)
    expect(capped).toMatchObject({ ok: false, httpStatus: 429 })
    expect(failure(capped)).toEqual({
      _tag: 'RateLimited',
      retryAfterSeconds: 6 * 24 * 60 * 60,
    })

    // The oldest pick leaves the window seven days after it was made.
    app.travel(Duration.days(6))
    expect(ok(await sigrun.pick(einar.profileId)).setup.status).toBe(
      'suggested'
    )
  })
})
