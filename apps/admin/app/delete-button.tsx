'use client'

import { deleteProfile } from './delete-actions.ts'

/** Asks first, naming the person, and warns louder for the showcase match. */
export function DeleteProfileButton({
  profileId,
  firstName,
  showcaseMatch,
}: {
  profileId: string
  firstName: string
  showcaseMatch: boolean
}) {
  const question = showcaseMatch
    ? `${firstName} is the showcase match. Deleting this profile breaks the demo until a new match is published. Delete ${firstName} anyway?`
    : `Delete ${firstName}? The profile, photo and setups go for good.`
  return (
    <form
      action={deleteProfile}
      onSubmit={(event) => {
        if (!window.confirm(question)) event.preventDefault()
      }}
    >
      <input type="hidden" name="profileId" value={profileId} />
      <button
        type="submit"
        className="rounded-md border border-red px-3 py-1 text-sm font-semibold text-red hover:bg-red/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        Delete {firstName}
      </button>
    </form>
  )
}
