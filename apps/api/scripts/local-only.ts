/**
 * The demo scripts write to whatever DATABASE_URL points at. A script run in
 * a shell that still has production credentials loaded must not seed or
 * approve anything there by accident, so they refuse any host but this
 * machine unless `--allow-remote` is passed, and always say where they are
 * about to write.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export const guardDatabaseTarget = (argv: ReadonlyArray<string>): void => {
  const raw = process.env.DATABASE_URL ?? ''
  let host: string
  try {
    host = new URL(raw).hostname
  } catch {
    console.error('DATABASE_URL is not set or is not a URL.')
    process.exit(1)
  }

  console.log(`Target database host: ${host}`)

  if (!LOCAL_HOSTS.has(host) && !argv.includes('--allow-remote')) {
    console.error(
      `Refusing to write to non-local host ${host}. Pass --allow-remote if you mean it.`
    )
    process.exit(1)
  }
}
