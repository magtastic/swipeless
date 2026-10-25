import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  hasTestDb,
  migrate,
  TestDbLive,
  truncateAll,
} from '@swipeless/db/testing'
import { Layer, ManagedRuntime } from 'effect'
import { Caller } from '../src/caller.ts'
import { EmbeddingModelDeterministic } from '../src/embeddings.ts'
import { Swipeless } from '../src/service.ts'
import {
  disposeHandlers,
  openHandler,
  type WebHandler,
} from './support/app-handler.ts'
import { callTool, initialize } from './support/mcp-client.ts'
import { TestPhotos } from './support/photos.ts'
import { approve } from './support/review.ts'
import { TestSeams } from './support/seams.ts'

/**
 * Authentication end to end: real database, real Caller, real service, both
 * transports, no fakes but the embedding model.
 *
 * The thing being proved is that MCP resolves its caller per call. Two agents
 * publish over one MCP session and then take turns using it with their own
 * tokens; each has to see the other and never themselves. If the profile were
 * resolved once when the layer was built — the shape this code had before —
 * the second agent would be served as the first and this test would fail.
 */

if (!hasTestDb) {
  console.warn(
    '\n' +
      '  #########################################################\n' +
      '  #  auth.test.ts SKIPPED: TEST_DATABASE_URL is not set.  #\n' +
      '  #  Run `bun run test:db` to exercise the database.      #\n' +
      '  #########################################################\n'
  )
}

/** The same shape as AppLive, with the test database and no OpenAI key. */
const AppLayer = Layer.mergeAll(Swipeless.Default, Caller.Default).pipe(
  Layer.provide(EmbeddingModelDeterministic),
  Layer.provide(TestPhotos),
  Layer.provide(TestSeams),
  Layer.provideMerge(TestDbLive)
)

const runtime = ManagedRuntime.make(AppLayer)

const HYDROLOGY_BRIEF =
  'She is a hydrologist who reads the weather like other people read faces. ' +
  'She values directness and dislikes being managed. Dealbreaker: calling a ' +
  'car park a hike.'

const CELLO_BRIEF =
  'He repairs cellos in a basement workshop and cycles everywhere. He values ' +
  'patience and long friendships. Dealbreaker: contempt for slow work.'

const profileArgs = (
  firstName: string,
  gender: 'woman' | 'man',
  interestedIn: ReadonlyArray<string>,
  brief: string
) => ({
  age: 34,
  gender,
  interestedIn: [...interestedIn],
  city: 'Reykjavík',
  country: 'IS',
  radiusKm: 25,
  availability: 'weekday evenings, sunday afternoons',
  brief,
  firstName,
  photoUrl: `https://example.invalid/${firstName}.jpg`,
  privateLayer: { phone: '+3548221234' },
})

type Published = { readonly profileId: string; readonly token: string }
type Candidates = { readonly candidates: ReadonlyArray<{ profileId: string }> }

/** Publishes over MCP, then approves, standing in for the review queue. */
const publish = async (
  handler: WebHandler,
  session: string | null,
  args: Record<string, unknown>
): Promise<Published> => {
  const json = await callTool(handler, 'swipeless_publish', args, { session })
  expect(json.result.isError).toBeFalsy()
  const published = json.result.structuredContent as Published
  await runtime.runPromise(approve(published.profileId))
  return published
}

const describeDb = hasTestDb ? describe : describe.skip

describeDb('authentication end to end', () => {
  beforeAll(() => runtime.runPromise(migrate))
  beforeEach(() => runtime.runPromise(truncateAll))
  afterAll(async () => {
    await disposeHandlers()
    await runtime.dispose()
  })

  test('one MCP session serves whichever agent holds the token', async () => {
    const handler = openHandler(AppLayer)
    // One session for everything that follows: the token is what identifies
    // the caller, not the connection.
    const session = await initialize(handler)

    const sigrun = await publish(
      handler,
      session,
      profileArgs('Sigrún', 'woman', ['man'], HYDROLOGY_BRIEF)
    )
    const jon = await publish(
      handler,
      session,
      profileArgs('Jón', 'man', ['woman'], CELLO_BRIEF)
    )

    const forSigrun = await callTool(
      handler,
      'swipeless_candidates',
      {},
      { session, token: sigrun.token }
    )
    const forJon = await callTool(
      handler,
      'swipeless_candidates',
      {},
      { session, token: jon.token }
    )

    expect(forSigrun.result.isError).toBeFalsy()
    expect(forJon.result.isError).toBeFalsy()
    expect(
      (forSigrun.result.structuredContent as Candidates).candidates.map(
        (one) => one.profileId
      )
    ).toEqual([jon.profileId])
    expect(
      (forJon.result.structuredContent as Candidates).candidates.map(
        (one) => one.profileId
      )
    ).toEqual([sigrun.profileId])
  })

  test('deleting a profile retires its token and leaves the other alone', async () => {
    const handler = openHandler(AppLayer)
    const session = await initialize(handler)

    const sigrun = await publish(
      handler,
      session,
      profileArgs('Sigrún', 'woman', ['man'], HYDROLOGY_BRIEF)
    )
    const jon = await publish(
      handler,
      session,
      profileArgs('Jón', 'man', ['woman'], CELLO_BRIEF)
    )

    const deleted = await callTool(
      handler,
      'swipeless_delete',
      {},
      { session, token: sigrun.token }
    )
    expect(deleted.result.isError).toBeFalsy()
    expect(deleted.result.structuredContent).toEqual({ deleted: true })

    // Deletion is a hard delete, so the token resolves to nothing at all.
    const afterDelete = await callTool(
      handler,
      'swipeless_candidates',
      {},
      { session, token: sigrun.token }
    )
    expect(afterDelete.result.isError).toBe(true)
    expect(afterDelete.result.structuredContent).toMatchObject({
      _tag: 'Unauthorized',
    })

    const stillJon = await callTool(
      handler,
      'swipeless_candidates',
      {},
      { session, token: jon.token }
    )
    expect(stillJon.result.isError).toBeFalsy()
    expect(
      (stillJon.result.structuredContent as Candidates).candidates
    ).toEqual([])
  })

  test('the same token works over REST', async () => {
    const handler = openHandler(AppLayer)
    const session = await initialize(handler)

    const sigrun = await publish(
      handler,
      session,
      profileArgs('Sigrún', 'woman', ['man'], HYDROLOGY_BRIEF)
    )
    const jon = await publish(
      handler,
      session,
      profileArgs('Jón', 'man', ['woman'], CELLO_BRIEF)
    )

    const res = await handler(
      new Request('http://localhost/candidates', {
        headers: { authorization: `Bearer ${sigrun.token}` },
      })
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as Candidates
    expect(body.candidates.map((one) => one.profileId)).toEqual([jon.profileId])

    const anonymous = await handler(new Request('http://localhost/candidates'))
    expect(anonymous.status).toBe(401)
  })
})
