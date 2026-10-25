import { DbLive } from '@swipeless/db'
import { ProfilePhotosLive } from '@swipeless/photos'
import { Layer } from 'effect'
import { Caller } from './caller.ts'
import { DateSuggesterRules } from './date-suggester.ts'
import { EmbeddingModelOpenAi } from './embeddings.ts'
import { NotifierLog } from './notifier.ts'
import { Swipeless } from './service.ts'

/**
 * The production application layer: the service and the caller resolver, both
 * over Postgres, with OpenAI behind the embeddings seam, the rule-based date
 * suggester, and a notifier that only logs until there is an SMS provider.
 * The bearer-auth middleware is derived from Caller inside http.ts, so it is
 * not here.
 *
 * Building this reads DATABASE_URL and OPENAI_API_KEY, so it fails fast on a
 * misconfigured deploy. Tests substitute their own layer of the same shape.
 */
export const AppLive = Layer.mergeAll(Swipeless.Default, Caller.Default).pipe(
  Layer.provide(DbLive),
  Layer.provide(ProfilePhotosLive),
  Layer.provide(EmbeddingModelOpenAi),
  Layer.provide(DateSuggesterRules),
  Layer.provide(NotifierLog)
)
