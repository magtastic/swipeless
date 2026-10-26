'use server'

import { sendShowcaseRequest } from '@swipeless/api/showcase-now'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { auth } from '../auth.ts'
import { showcaseEnabled } from '../lib/showcase.ts'

/** SHOWCASE ONLY: the staged date request to `targetId`, now. */
export async function sendShowcaseRequestNow(form: FormData): Promise<void> {
  const session = await auth()
  if (!showcaseEnabled(session?.user?.email)) return
  const targetId = form.get('targetId')
  if (typeof targetId !== 'string') return
  const outcome = await sendShowcaseRequest(targetId)
  revalidatePath('/')
  const result =
    outcome._tag === 'Done'
      ? `date request is ${outcome.status}`
      : `refused: ${outcome.reason.split('\n')[0]}`
  redirect(`/?showcase=${encodeURIComponent(result)}#showcase`)
}
