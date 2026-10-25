import { DbLive, PgDrizzle } from '@swipeless/db'
import { adminEvents, profiles } from '@swipeless/db/schema'
import { PhotoLinks, PhotoStorage, photoLinks } from '@swipeless/photos'
import { type Gender, PrivateLayer, Profile } from '@swipeless/shared'
import { inArray, like } from 'drizzle-orm'
import { Effect, Layer } from 'effect'
import { DateSuggesterRules } from '../src/date-suggester.ts'
import {
  EmbeddingModelDeterministic,
  EmbeddingModelOpenAi,
} from '../src/embeddings.ts'
import { NotifierLog } from '../src/notifier.ts'
import { Swipeless } from '../src/service.ts'
import { guardDatabaseTarget } from './local-only.ts'

/**
 * Seeds a small, approved Reykjavík pool for a live demo.
 *
 *   bun run seed:demo                     # OpenAI embeddings (OPENAI_API_KEY)
 *   bun run seed:demo --fake-embeddings   # deterministic, keyless
 *   … --allow-remote                      # write to a non-local DATABASE_URL
 *
 * Reads DATABASE_URL like the app and refuses a non-local host unless told
 * otherwise. Phone numbers are in the fictional NANP range +1 555 555 01xx,
 * so no seeded profile can text a real person. Every seeded profile carries an email at
 * SEED_DOMAIN, which is the tag: a rerun deletes the tagged profiles (and,
 * by cascade, their setups) before inserting fresh ones, so the pool never
 * doubles. Profiles go in through `Swipeless.publish`, exactly as an agent's
 * would, and are then approved, standing in for the review queue.
 *
 * Prints each profile's id and bearer token, so the demo can act as the
 * other side of a date (confirm or decline as them).
 */

const SEED_DOMAIN = 'seed.swipeless.invalid'

type Seed = {
  readonly firstName: string
  readonly age: number
  readonly gender: Gender
  readonly interestedIn: readonly [Gender, ...Array<Gender>]
  readonly photo: string
  readonly phone: string
  readonly availability: string
  readonly brief: string
}

const portrait = (set: 'women' | 'men', n: number) =>
  `https://randomuser.me/api/portraits/${set}/${n}.jpg`

const SEEDS: ReadonlyArray<Seed> = [
  {
    firstName: 'Sigrún',
    age: 29,
    gender: 'woman',
    interestedIn: ['man'],
    photo: portrait('women', 44),
    phone: '+15555550100',
    availability: 'weekday evenings, sunday afternoons',
    brief:
      '## Who she is\nSigrún is a hydrologist at the Met Office who reads the weather like other people read faces.\n\n## How she lives\nShe swims in Vesturbæjarlaug most mornings and spends weekends hiking Esja or Reykjadalur.\n\n## What she values\nDirectness, curiosity, and people who keep their word.\n\n## What she wants\nSomeone with their own thing going on who would rather walk and talk than sit in a bar.\n\n## Dealbreakers\nCalling a car park a hike.',
  },
  {
    firstName: 'Katrín',
    age: 33,
    gender: 'woman',
    interestedIn: ['man'],
    photo: portrait('women', 68),
    phone: '+15555550101',
    availability: 'thursday evenings, saturday afternoons',
    brief:
      '## Who she is\nKatrín is a paediatric nurse at Landspítali with a dry sense of humour.\n\n## How she lives\nShift work, a lot of podcasts, and a small balcony full of tomatoes she talks to.\n\n## What she values\nKindness when nobody is watching, and being on time.\n\n## What she wants\nSomething steady with someone who can cook at least one thing well.\n\n## Dealbreakers\nRudeness to waiters.',
  },
  {
    firstName: 'Hildur',
    age: 27,
    gender: 'woman',
    interestedIn: ['woman', 'non_binary'],
    photo: portrait('women', 21),
    phone: '+15555550102',
    availability: 'weekends',
    brief:
      '## Who she is\nHildur is a graphic designer who makes gig posters for half the bands in town.\n\n## How she lives\nRecord shops on Laugavegur, late breakfasts, and an old bike she refuses to replace.\n\n## What she values\nTaste, honesty, and people who laugh easily.\n\n## What she wants\nSomeone to go to shows with and stay up talking afterwards.\n\n## Dealbreakers\nPeople who only talk about work.',
  },
  {
    firstName: 'Elín',
    age: 38,
    gender: 'woman',
    interestedIn: ['man'],
    photo: portrait('women', 52),
    phone: '+15555550103',
    availability: 'weekday evenings',
    brief:
      '## Who she is\nElín is an architect and a mother of a ten-year-old who is funnier than she is.\n\n## How she lives\nEarly mornings, long walks around Tjörnin, and a book club that mostly drinks wine.\n\n## What she values\nCalm, generosity, and a good argument about buildings.\n\n## What she wants\nA grown-up relationship with someone settled in themselves.\n\n## Dealbreakers\nPlaying games instead of saying what you mean.',
  },
  {
    firstName: 'Gunnar',
    age: 31,
    gender: 'man',
    interestedIn: ['woman'],
    photo: portrait('men', 32),
    phone: '+15555550104',
    availability: 'weekday evenings, sunday afternoons',
    brief:
      '## Who he is\nGunnar is a glacier guide in summer and a carpenter in winter.\n\n## How he lives\nOutdoors as much as possible, sea swimming at Nauthólsvík, and cooking for friends on Sundays.\n\n## What he values\nReliability, curiosity, and people who are good company in bad weather.\n\n## What he wants\nSomeone adventurous who also likes a quiet night in.\n\n## Dealbreakers\nContempt for people who work with their hands.',
  },
  {
    firstName: 'Bjarki',
    age: 35,
    gender: 'man',
    interestedIn: ['woman'],
    photo: portrait('men', 75),
    phone: '+15555550105',
    availability: 'thursday evenings, weekends',
    brief:
      '## Who he is\nBjarki is a software developer who repairs old synthesizers on the side.\n\n## How he lives\nBouldering twice a week, coffee at the same café every Saturday, too many cables at home.\n\n## What he values\nPatience, humour, and long friendships.\n\n## What he wants\nA partner to share small rituals with.\n\n## Dealbreakers\nPhones out at dinner.',
  },
  {
    firstName: 'Ólafur',
    age: 28,
    gender: 'man',
    interestedIn: ['man'],
    photo: portrait('men', 11),
    phone: '+15555550106',
    availability: 'weekends',
    brief:
      '## Who he is\nÓlafur is a chef at a small seafood place by the old harbour.\n\n## How he lives\nLate nights, Monday mornings off, and a running habit he swears is not a personality.\n\n## What he values\nWarmth, appetite, and people who say yes to a plan.\n\n## What he wants\nSomeone to explore the city with on his days off.\n\n## Dealbreakers\nPicky eaters who are proud of it.',
  },
  {
    firstName: 'Davíð',
    age: 40,
    gender: 'man',
    interestedIn: ['woman'],
    photo: portrait('men', 46),
    phone: '+15555550107',
    availability: 'weekday evenings',
    brief:
      '## Who he is\nDavíð teaches history at Menntaskólinn and coaches his daughter’s football team.\n\n## How he lives\nRoutines, crosswords, and a long Sunday swim at Laugardalslaug.\n\n## What he values\nKindness, steadiness, and a sense of humour about getting older.\n\n## What he wants\nA real partner, not a project.\n\n## Dealbreakers\nCynicism as a hobby.',
  },
]

guardDatabaseTarget(process.argv)

const fakeEmbeddings = process.argv.includes('--fake-embeddings')

/**
 * Seeded photos are external https URLs, which publish stores as they are;
 * nothing here uploads, so object storage and link signing are inert.
 */
const NoObjectStorage = Layer.mergeAll(
  Layer.succeed(
    PhotoStorage,
    PhotoStorage.of({
      upload: () => Effect.dieMessage('seed photos are https URLs'),
      remove: () => Effect.void,
      read: () => Effect.succeed(null),
    })
  ),
  Layer.succeed(PhotoLinks, photoLinks('seed-unused', 'https://invalid'))
)

const seed = Effect.gen(function* () {
  const db = yield* PgDrizzle.PgDrizzle
  const service = yield* Swipeless

  const removed = yield* db
    .delete(profiles)
    .where(like(profiles.email, `%@${SEED_DOMAIN}`))
    .returning({ id: profiles.id })

  const seeded: Array<{ firstName: string; profileId: string; token: string }> =
    []
  for (const one of SEEDS) {
    const published = yield* service.publish(
      new Profile({
        age: one.age,
        gender: one.gender,
        interestedIn: one.interestedIn,
        city: 'Reykjavík',
        country: 'IS',
        radiusKm: 25,
        availability: one.availability,
        brief: one.brief,
        firstName: one.firstName,
        photoUrl: one.photo,
        privateLayer: new PrivateLayer({ phone: one.phone }),
        email: `${one.firstName
          .normalize('NFD')
          .replace(/\p{Diacritic}/gu, '')
          .toLowerCase()}@${SEED_DOMAIN}`,
      })
    )
    seeded.push({ firstName: one.firstName, ...published })
  }

  const ids = seeded.map((one) => one.profileId)
  const at = new Date()
  yield* db
    .update(profiles)
    .set({ reviewStatus: 'approved', reviewedAt: at })
    .where(inArray(profiles.id, ids))
  yield* db.insert(adminEvents).values(
    ids.map((profileId) => ({
      kind: 'profile.approved',
      profileId,
      payload: { via: 'seed' },
      createdAt: at,
    }))
  )

  console.log(
    `Removed ${removed.length} earlier seed profiles, seeded ${seeded.length} approved ones` +
      (fakeEmbeddings ? ' (fake embeddings).' : '.')
  )
  console.table(seeded)
})

const App = Swipeless.Default.pipe(
  Layer.provide(
    fakeEmbeddings ? EmbeddingModelDeterministic : EmbeddingModelOpenAi
  ),
  Layer.provide(NoObjectStorage),
  Layer.provide(DateSuggesterRules),
  Layer.provide(NotifierLog),
  Layer.provideMerge(DbLive)
)

await Effect.runPromise(seed.pipe(Effect.provide(App)))
