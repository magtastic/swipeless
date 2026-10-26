import { readFileSync } from 'node:fs'

/**
 * SHOWCASE ONLY (docs/decisions.md, 2026-10-26): publishes the prepared match
 * profile for the live demo through the public API, exactly as an agent
 * would, from a JSON file in the publish shape.
 *
 *   bun run showcase:publish <file.json> --target https://api.swipeless.me
 *
 * The target is never defaulted: the script says where it is writing and
 * will not run without being told. It needs no database credentials. It
 * prints the profile id, for SHOWCASE_MATCH_PROFILE_ID, and the token, which
 * is the only way to delete the profile again (DELETE /profile).
 */

const args = process.argv.slice(2)
const file = args.find((arg) => arg.endsWith('.json'))
const target = args[args.indexOf('--target') + 1]
if (file === undefined || !args.includes('--target') || !target) {
  console.error(
    'usage: bun run showcase:publish <file.json> --target https://api.swipeless.me'
  )
  process.exit(1)
}

const profile = JSON.parse(readFileSync(file, 'utf8')) as {
  readonly firstName?: string
  readonly privateLayer?: { readonly phone?: string }
}
const unfilled = JSON.stringify(profile).match(/FILL[ -]IN/i)
if (unfilled) {
  console.error(`${file} still has a FILL IN placeholder.`)
  process.exit(1)
}
// His number is texted to hers once he says yes.
console.log(
  `Her phone is ${profile.privateLayer?.phone}. It must be a number Smitten controls.`
)

const base = new URL(target)
console.log(`Publishing ${profile.firstName} to ${base.origin}`)
const response = await fetch(new URL('/publish', base), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(profile),
})
const body = await response.text()
if (!response.ok) {
  console.error(`${response.status}: ${body}`)
  process.exit(1)
}
const { profileId, token } = JSON.parse(body) as {
  readonly profileId: string
  readonly token: string
}
console.log(`SHOWCASE_MATCH_PROFILE_ID=${profileId}`)
console.log(`token (keep it to delete her later): ${token}`)
