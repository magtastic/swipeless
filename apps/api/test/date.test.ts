import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { adminEvents, profiles } from '@swipeless/db/schema'
import { validPhotoSignature } from '@swipeless/photos'
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
import { hasTestDb, openApp, PHOTO_SECRET, warnSkipped } from './support/app.ts'

/**
 * The product, start to finish: two agents publish, a person approves them,
 * one agent picks the other, both humans say yes, and each gets the other's
 * phone number. Sigrún's agent speaks MCP and Jón's speaks REST, so every step
 * also proves the two transports agree.
 */

warnSkipped('date.test.ts')

describe.skipIf(!hasTestDb)('a pick becomes a date', () => {
  const app = openApp()
  beforeEach(app.reset)
  afterAll(app.dispose)

  test('from publish to two phone numbers, and back out again', async () => {
    const sigrun = await publish(
      app.handler,
      'mcp',
      profile({ firstName: 'Sigrún', phone: '+3548221234' })
    )
    const jon = await publish(
      app.handler,
      'rest',
      man({ firstName: 'Jón', phone: '+3546905678', brief: CELLO_BRIEF })
    )

    // Only hashes of the tokens and keys of the photos are stored, and the
    // admin site is told a signup happened and nothing personal.
    const stored = await app.query((db) =>
      db
        .select({
          id: profiles.id,
          tokenHash: profiles.tokenHash,
          photo: profiles.photoUrl,
        })
        .from(profiles)
    )
    for (const row of stored) {
      expect([sigrun.token, jon.token]).not.toContain(row.tokenHash)
      expect(row.photo).toMatch(/^photos\//)
      expect(app.photos.has(row.photo ?? '')).toBe(true)
    }
    const events = await app.query((db) =>
      db.select({ payload: adminEvents.payload }).from(adminEvents)
    )
    // No ORDER BY, so the two rows may come back in either order.
    expect(events).toHaveLength(2)
    expect(events.map((one) => one.payload)).toEqual(
      expect.arrayContaining([
        { country: 'IS', gender: 'woman' },
        { country: 'IS', gender: 'man' },
      ])
    )

    // Nobody is live until a person has checked them.
    expect(ids(await sigrun.candidates())).toEqual([])
    expect(failure(await sigrun.pick(jon.profileId))._tag).toBe('NotFound')
    await app.approve(sigrun.profileId, jon.profileId)

    // Candidates carry the core and the brief, never the note or the phone.
    const forSigrun = ok(await sigrun.candidates())
    expect(forSigrun.candidates.map((one) => one.profileId)).toEqual([
      jon.profileId,
    ])
    expect(Object.keys(forSigrun.candidates[0]?.core ?? {}).sort()).toEqual(
      [
        'age',
        'availability',
        'city',
        'country',
        'gender',
        'interestedIn',
      ].sort()
    )
    expect(JSON.stringify(forSigrun)).not.toContain('Jón')
    expect(JSON.stringify(forSigrun)).not.toContain('+3546905678')
    expect(ids(await jon.candidates())).toEqual([sigrun.profileId])

    // The pick: swipeless suggests a real café on the next Thursday evening
    // at least two days out, and Sigrún's agent gets the note to show her.
    const { setup } = ok(await sigrun.pick(jon.profileId))
    expect(setup.status).toBe('suggested')
    expect(setup.youPicked).toBe(true)
    expect(setup.date.time).toBe('2026-09-03T19:30:00.000Z')
    expect(setup.date.venue.address).toContain('Reykjavík')
    expect(setup.counterpart).toMatchObject({
      profileId: jon.profileId,
      firstName: 'Jón',
      age: 34,
      brief: CELLO_BRIEF,
    })
    expect(setup.counterpartPrivateLayer).toBeUndefined()

    // The photo link is signed for Jón alone and lasts ten minutes.
    const link = new URL(setup.counterpart.photoUrl)
    expect(link.origin + link.pathname).toBe(
      `https://photos.example/api/photos/${jon.profileId}`
    )
    const expires = Number(link.searchParams.get('expires'))
    const signature = link.searchParams.get('signature') ?? ''
    const now = Math.floor(app.now() / 1000)
    const valid = (profileId: string, at: number) =>
      validPhotoSignature(profileId, expires, signature, PHOTO_SECRET, at)
    expect(valid(jon.profileId, now)).toBe(true)
    expect(valid(sigrun.profileId, now)).toBe(false)
    expect(valid(jon.profileId, now + 600)).toBe(false)

    // Until Sigrún says yes, Jón cannot know he was picked.
    expect(ok(await jon.setups()).setups).toEqual([])
    expect(failure(await jon.confirm(setup.setupId))._tag).toBe('NotFound')

    // Her yes sends him the date request.
    expect(ok(await sigrun.confirm(setup.setupId))).toEqual({
      status: 'requested',
    })
    expect(app.notifications).toEqual([
      {
        kind: 'dateRequested',
        profileId: jon.profileId,
        setupId: setup.setupId,
      },
    ])
    const requested = ok(await jon.setups()).setups
    expect(requested).toHaveLength(1)
    expect(requested[0]).toMatchObject({
      setupId: setup.setupId,
      status: 'requested',
      youPicked: false,
      youConfirmed: false,
      counterpart: { profileId: sigrun.profileId, firstName: 'Sigrún' },
    })
    expect(requested[0]?.counterpartPrivateLayer).toBeUndefined()

    // His yes confirms the date and releases her number to him...
    expect(ok(await jon.confirm(setup.setupId))).toEqual({
      status: 'confirmed',
      privateLayer: { phone: '+3548221234' },
    })
    expect(app.notifications.slice(1)).toEqual([
      {
        kind: 'dateConfirmed',
        profileId: jon.profileId,
        setupId: setup.setupId,
      },
      {
        kind: 'dateConfirmed',
        profileId: sigrun.profileId,
        setupId: setup.setupId,
      },
    ])
    // ...and his to her, which her agent recovers by listing.
    const hers = ok(await sigrun.setups()).setups[0]
    expect(hers?.status).toBe('confirmed')
    expect(hers?.counterpartPrivateLayer).toEqual({ phone: '+3546905678' })

    // A confirmed date is settled: no taking it back, and it never expires.
    expect(failure(await jon.decline(setup.setupId))).toMatchObject({
      _tag: 'Conflict',
      status: 'confirmed',
    })
    app.travel(Duration.days(30))
    expect(ok(await jon.setups()).setups[0]?.status).toBe('confirmed')

    // Deleting is a hard delete: the photo, the setup and the token go too.
    const photoOf = (id: string) =>
      stored.find((row) => row.id === id)?.photo ?? ''
    expect(ok(await sigrun.remove())).toEqual({ deleted: true })
    expect(app.photos.has(photoOf(sigrun.profileId))).toBe(false)
    expect(app.photos.has(photoOf(jon.profileId))).toBe(true)
    expect(ok(await jon.setups()).setups).toEqual([])
    expect(failure(await sigrun.setups())._tag).toBe('Unauthorized')
    const deleted = await app.query((db) =>
      db.select({ kind: adminEvents.kind }).from(adminEvents)
    )
    expect(deleted.map((one) => one.kind)).toContain('profile.deleted')
  })

  test('the suggested date fits both availabilities', async () => {
    // START is a Tuesday morning and a date is at least two days out, so the
    // next Thursday evening is 3 September and the next Saturday afternoon 5.
    const THURSDAY = '2026-09-03T19:30:00.000Z'
    const SATURDAY = '2026-09-05T15:00:00.000Z'

    const dateFor = async (hers: string, his: string) => {
      const sigrun = await publish(
        app.handler,
        'rest',
        profile({ firstName: 'Sigrún', availability: hers })
      )
      const jon = await publish(
        app.handler,
        'rest',
        man({ firstName: 'Jón', availability: his })
      )
      await app.approve(sigrun.profileId, jon.profileId)
      return ok(await sigrun.pick(jon.profileId)).setup.date.time
    }

    // A slot both can make, though Thursday comes first.
    expect(
      await dateFor('saturday afternoons', 'thursday evenings, weekends')
    ).toBe(SATURDAY)
    // Availability that names no slot rules nothing out.
    expect(await dateFor('weekends', 'flexible')).toBe(SATURDAY)
    // Nothing in common: Thursday evening, a guess rather than a fit.
    expect(await dateFor('weekends', 'thursday evenings')).toBe(THURSDAY)
  })
})
