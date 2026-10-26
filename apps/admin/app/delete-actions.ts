'use server'

import { revalidatePath } from 'next/cache'
import { auth } from '../auth.ts'
import { deleteProfileAsAdmin } from '../lib/delete.ts'

/** SHOWCASE ONLY: delete a profile. `deleteProfileAsAdmin` refuses anyone but the super admin. */
export async function deleteProfile(form: FormData): Promise<void> {
  const session = await auth()
  const profileId = form.get('profileId')
  if (typeof profileId !== 'string') return
  const outcome = await deleteProfileAsAdmin(profileId, session?.user?.email)
  if (outcome._tag === 'Unavailable') throw new Error(outcome.reason)
  revalidatePath('/')
}
