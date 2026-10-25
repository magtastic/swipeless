'use server'

import { actAs } from '@swipeless/api/act-as'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { auth } from '../auth.ts'
import { testToolsEnabled } from '../lib/test-tools.ts'

/**
 * Local only: `actorId`'s agent picks `targetId` and their human says yes.
 * Re-reads the session like every server action; `actAs` also refuses in
 * production on its own.
 */
export async function pickAndSayYes(form: FormData): Promise<void> {
  const session = await auth()
  if (!testToolsEnabled(session?.user?.email)) return
  const actorId = form.get('actorId')
  const targetId = form.get('targetId')
  if (typeof actorId !== 'string' || typeof targetId !== 'string') return
  const outcome = await actAs(actorId, targetId)
  revalidatePath('/')
  const result =
    outcome._tag === 'Done'
      ? `setup is now ${outcome.status}`
      : `refused: ${outcome.reason.split('\n')[0]}`
  redirect(`/?test=${encodeURIComponent(result)}#test-tools`)
}
