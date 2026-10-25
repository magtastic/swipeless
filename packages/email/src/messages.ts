import type { Email } from './index.ts'

/**
 * Every email swipeless sends, as plain text. Copy follows the Voice section
 * of PRODUCT.md: a short letter from a friend, "you" and "them", no is always
 * enough, never "AI dating".
 */

export interface DatePlace {
  readonly venue: { readonly name: string; readonly address: string }
  /** ISO-8601. */
  readonly time: string
}

/**
 * Iceland is the only market, and Atlantic/Reykjavik is UTC all year, which
 * is also what the date suggester assumes everywhere else.
 */
export const formatDateTime = (iso: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Atlantic/Reykjavik',
  }).format(new Date(iso))

const where = (date: DatePlace) =>
  `where: ${date.venue.name}, ${date.venue.address}\nwhen: ${formatDateTime(date.time)}`

const SIGN_OFF = 'xo, swipeless'

/** The review gate passed: "A person checks every profile before it goes live." */
export const profileApproved = (to: string, firstName: string): Email => ({
  to,
  subject: "you're live on swipeless",
  text: [
    `hi ${firstName},`,
    'a real person at swipeless read your profile, and it is live now.',
    'your agent will look for someone worth meeting. nothing to do until then: go live your life, we will write when there is a date.',
    SIGN_OFF,
  ].join('\n\n'),
})

/** The date request: one human said yes, and this is the other. */
export const dateRequested = (
  to: string,
  firstName: string,
  otherFirstName: string,
  date: DatePlace
): Email => ({
  to,
  subject: `${otherFirstName} would like to meet you`,
  text: [
    `hi ${firstName},`,
    `${otherFirstName} would like to meet you.`,
    where(date),
    'ask your agent about swipeless to see who they are, then say yes or no. no is always enough, and nobody is told why.',
    SIGN_OFF,
  ].join('\n\n'),
})

/** Both said yes: "both get the other's phone number". */
export const dateConfirmed = (
  to: string,
  firstName: string,
  otherFirstName: string,
  otherPhone: string,
  date: DatePlace
): Email => ({
  to,
  subject: "it's a date",
  text: [
    `hi ${firstName},`,
    `you and ${otherFirstName} both said yes.`,
    where(date),
    `${otherFirstName}'s number: ${otherPhone}`,
    'text them, call them, whatever feels right. have fun.',
    SIGN_OFF,
  ].join('\n\n'),
})

/** Sent by hand from the admin site after the date. Replies come to us. */
export const howWasTheDate = (
  to: string,
  firstName: string,
  otherFirstName: string
): Email => ({
  to,
  subject: 'how was the date?',
  text: [
    `hi ${firstName},`,
    `how was the date with ${otherFirstName}?`,
    'just reply to this email, a line is plenty. it helps us find your next one, and if anything felt off, tell us. we read every reply.',
    SIGN_OFF,
  ].join('\n\n'),
})
