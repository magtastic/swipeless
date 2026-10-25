'use server'

import { revalidatePath } from 'next/cache'
import { auth } from '../auth.ts'
import { type ReviewDecision, recordReview } from '../lib/review.ts'

/**
 * Server actions are public POST endpoints, so each one re-reads the session
 * here and passes only the server-verified email on. `recordReview` refuses
 * anyone but the super admin before touching the database.
 */
const decide = async (decision: ReviewDecision, form: FormData) => {
  const session = await auth()
  const profileId = form.get('profileId')
  if (typeof profileId !== 'string') return
  const outcome = await recordReview(profileId, decision, session?.user?.email)
  if (outcome._tag === 'Unavailable') throw new Error(outcome.reason)
  revalidatePath('/')
}

export async function approveProfile(form: FormData): Promise<void> {
  await decide('approved', form)
}

export async function rejectProfile(form: FormData): Promise<void> {
  await decide('rejected', form)
}
