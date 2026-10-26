import { DbLive } from '@swipeless/db'
import { MailerLive } from '@swipeless/email'
import { ProfilePhotosLive } from '@swipeless/photos'
import { Layer } from 'effect'
import { AfterResponseVercel } from './after-response.ts'
import { Caller } from './caller.ts'
import { DateSuggesterRules } from './date-suggester.ts'
import { EmbeddingModelOpenAi } from './embeddings.ts'
import { FitWriterClaude } from './fit-writer.ts'
import { NotifierLive } from './notifier.ts'
import { Swipeless } from './service.ts'
import { SmsLive } from './sms.ts'

/**
 * The production application layer: the service and the caller resolver, both
 * over Postgres, with OpenAI behind the embeddings seam, the rule-based date
 * suggester, and a notifier that texts through Twilio and emails through
 * Resend (each only logs without its key).
 * The bearer-auth middleware is derived from Caller inside http.ts, so it is
 * not here.
 *
 * Building this reads DATABASE_URL and OPENAI_API_KEY, so it fails fast on a
 * misconfigured deploy. Tests substitute their own layer of the same shape.
 */
export const AppLive = Layer.mergeAll(Swipeless.Default, Caller.Default).pipe(
  // Merged out too: the MCP publish tool stores ChatGPT uploads itself.
  Layer.provideMerge(ProfilePhotosLive),
  Layer.provide(EmbeddingModelOpenAi),
  Layer.provide(AfterResponseVercel),
  Layer.provide(DateSuggesterRules),
  Layer.provide(NotifierLive),
  Layer.provide(FitWriterClaude),
  Layer.provide(MailerLive),
  Layer.provide(SmsLive),
  Layer.provide(DbLive)
)
