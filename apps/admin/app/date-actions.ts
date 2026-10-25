'use server'

import { revalidatePath } from 'next/cache'
import { auth } from '../auth.ts'
import { sendFollowUp } from '../lib/dates.ts'

/**
 * A public POST endpoint like every server action, so it re-reads the session
 * and passes only the server-verified email on. `sendFollowUp` refuses anyone
 * but the super admin before touching the database.
 */
export async function followUpDate(form: FormData): Promise<void> {
  const session = await auth()
  const setupId = form.get('setupId')
  if (typeof setupId !== 'string') return
  const outcome = await sendFollowUp(setupId, session?.user?.email)
  if (outcome._tag === 'Unavailable') throw new Error(outcome.reason)
  revalidatePath('/')
}
