import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { waitlist } from '@swipeless/db/schema'
import { hasTestDb, openApp, warnSkipped } from './support/app.ts'

/**
 * The waitlist form on swipeless.me, over the whole app. The site proxies
 * `/waitlist` to the API, so this posts exactly what the form does.
 */

warnSkipped('waitlist.test.ts')

describe.skipIf(!hasTestDb)('joining the closed beta waitlist', () => {
  const app = openApp()
  beforeEach(app.reset)
  afterAll(app.dispose)

  const join = (email: string) =>
    app.handler(
      new Request('http://api.test/waitlist', {
        method: 'POST',
        body: new URLSearchParams({ email }),
      })
    )

  const emails = () =>
    app.query((db) => db.select({ email: waitlist.email }).from(waitlist))

  test('an email goes on the list once, however often it is sent', async () => {
    const first = await join('  Sigrun@Example.is ')
    expect(first.status).toBe(200)
    expect(await first.text()).toContain("you're on the list.")
    expect((await join('sigrun@example.is')).status).toBe(200)

    expect(await emails()).toEqual([{ email: 'sigrun@example.is' }])
  })

  test('something that is not an email is turned away', async () => {
    for (const email of ['', 'sigrun', 'sigrun@example', 'a b@example.is']) {
      const response = await join(email)
      expect(response.status).toBe(400)
      expect(await response.text()).toContain("that email didn't look right.")
    }
    expect(await emails()).toEqual([])
  })
})
