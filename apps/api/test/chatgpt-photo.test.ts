import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { profiles } from '@swipeless/db/schema'
import {
  callTool,
  failure,
  initialize,
  man,
  mcp,
  ok,
  PNG,
  profile,
  publish,
} from './support/agent.ts'
import { hasTestDb, openApp, warnSkipped } from './support/app.ts'

/**
 * In ChatGPT a person drops a photo into the chat and swipeless_publish
 * receives it as a file: ChatGPT reads `_meta["openai/fileParams"]` off
 * tools/list and passes `{ download_url, file_id }` in place of the argument.
 * Showcase-only (docs/decisions.md, 2026-10-26).
 */

warnSkipped('chatgpt-photo.test.ts')

const PNG_BYTES = new Uint8Array(Buffer.from(PNG.split(',')[1] ?? '', 'base64'))
const DOWNLOAD = 'https://files.oaiusercontent.com/file-abc123?se=2026&sig=x'

/** Sigrún as ChatGPT would publish her: the photo is an upload, not a URL. */
const uploaded = (photo: unknown) => {
  const { photoUrl: _, ...rest } = profile({ firstName: 'Sigrún' })
  return { ...rest, photo }
}

describe.skipIf(!hasTestDb)('a photo uploaded in ChatGPT', () => {
  const app = openApp()
  beforeEach(app.reset)
  afterAll(app.dispose)

  test('tools/list marks the photo as a file parameter ChatGPT accepts', async () => {
    const session = await initialize(app.handler)
    const res = await mcp(app.handler, { method: 'tools/list' }, { session })
    const body = await res.text()
    // A stale length from before _meta was added truncates the answer in production.
    const length = res.headers.get('content-length')
    if (length !== null) expect(Number(length)).toBe(Buffer.byteLength(body))
    const { result } = JSON.parse(body) as {
      readonly result: {
        readonly tools: ReadonlyArray<{
          readonly name: string
          readonly inputSchema: {
            readonly properties: Record<string, unknown>
          }
          readonly _meta?: Record<string, unknown>
        }>
      }
    }
    const tool = result.tools.find((one) => one.name === 'swipeless_publish')
    expect(tool?._meta).toEqual({ 'openai/fileParams': ['photo'] })
    expect(tool?.inputSchema.properties.photo).toMatchObject({
      type: 'object',
      properties: {
        download_url: { type: 'string' },
        file_id: { type: 'string' },
        mime_type: { type: 'string' },
        file_name: { type: 'string' },
      },
      required: ['download_url', 'file_id'],
    })
    // No other tool takes a file.
    const others = result.tools.filter((one) => one._meta !== undefined)
    expect(others.map((one) => one.name)).toEqual(['swipeless_publish'])
  })

  test('the dropped photo is stored and shown to the person she is matched with', async () => {
    app.uploads.set(DOWNLOAD, PNG_BYTES)
    const sigrun = await publish(
      app.handler,
      'mcp',
      uploaded({
        download_url: DOWNLOAD,
        file_id: 'file_abc123',
        mime_type: 'image/png',
        file_name: 'me.png',
      })
    )

    const [row] = await app.query((db) =>
      db.select({ photo: profiles.photoUrl }).from(profiles)
    )
    expect(row?.photo).toMatch(/^photos\/[0-9a-f-]+\.png$/)
    expect(app.photos.get(row?.photo ?? '')).toEqual({
      bytes: PNG_BYTES,
      contentType: 'image/png',
    })

    const jon = await publish(app.handler, 'rest', man({ firstName: 'Jón' }))
    const setup = ok(await jon.pick(sigrun.profileId)).setup
    const link = new URL(setup.counterpart.photoUrl)
    expect(link.pathname).toBe(`/api/photos/${sigrun.profileId}`)
    expect(
      app.photoLinkValid(sigrun.profileId, link.searchParams, app.now())
    ).toBe(true)
  })

  test('a photo from anywhere but ChatGPT, or not a photo at all, is BadPhoto', async () => {
    const elsewhere = 'https://evil.example/file-abc123.png'
    const plainHttp = 'http://files.oaiusercontent.com/file-abc123'
    const text = 'https://files.oaiusercontent.com/file-notes'
    app.uploads.set(elsewhere, PNG_BYTES)
    app.uploads.set(plainHttp, PNG_BYTES)
    app.uploads.set(text, new TextEncoder().encode('not really an image'))
    const file = (download_url: string) => ({
      download_url,
      file_id: 'file_abc123',
    })

    const { photo: _, ...withoutPhoto } = uploaded(undefined)
    const refused = [
      uploaded(file(elsewhere)),
      uploaded(file(plainHttp)),
      uploaded(file(text)),
      // Not in the store: the download fails.
      uploaded(file('https://files.oaiusercontent.com/file-gone')),
      // What ChatGPT on mobile sometimes sends instead of the file.
      uploaded('chat_upload'),
      withoutPhoto,
    ]

    const session = await initialize(app.handler)
    for (const args of refused) {
      const outcome = await callTool(
        app.handler,
        session,
        'swipeless_publish',
        args
      )
      expect(failure(outcome)._tag).toBe('BadPhoto')
    }

    expect(await app.query((db) => db.select().from(profiles))).toEqual([])
    expect(app.photos.size).toBe(0)
  })
})
