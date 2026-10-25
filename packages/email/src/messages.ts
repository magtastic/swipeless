import type { Email } from './index.ts'
import { checkbox, escapeHtml, highlight, type Line, note } from './note.ts'

/**
 * Every email swipeless sends, as a handwritten note with a plain-text twin.
 * Copy follows the Voice section of PRODUCT.md: a short letter from a friend,
 * "you" and "them", no is always enough, never "AI dating".
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

/** The place and the time as ruled lines, with the time highlighted. */
const whereLines = (date: DatePlace): ReadonlyArray<Line> => [
  { hand: `where: ${escapeHtml(date.venue.name)}` },
  { print: escapeHtml(date.venue.address) },
  { hand: `when: ${highlight(escapeHtml(formatDateTime(date.time)))}` },
]

const SIGN_OFF = 'xo, swipeless'

const hi = (firstName: string): Line => ({
  hand: `hi ${escapeHtml(firstName)},`,
  size: 32,
})
const signOff: Line = { hand: SIGN_OFF }
const blank: Line = { blank: true }

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
  html: note('a real person read your profile. you are live.', [
    hi(firstName),
    { hand: 'a real person read your profile.' },
    { hand: `you're ${highlight('live')} now.` },
    blank,
    {
      print:
        'your agent will look for someone worth meeting. nothing to do until then.',
    },
    { hand: 'go live your life, we will write.' },
    blank,
    signOff,
  ]),
})

/** Links to the small yes-or-no page, one per answer. */
export interface AnswerLinks {
  readonly yes: string
  readonly no: string
}

/**
 * The date request: one human said yes, and this is the other. With answer
 * links the boxes open the small page; without, they answer through their
 * agent.
 */
export const dateRequested = (
  to: string,
  firstName: string,
  otherFirstName: string,
  date: DatePlace,
  answer?: AnswerLinks
): Email => ({
  to,
  subject: `${otherFirstName} would like to meet you`,
  text: [
    `hi ${firstName},`,
    `${otherFirstName} would like to meet you.`,
    where(date),
    answer
      ? `do you want to go out?\n\nyes: ${answer.yes}\nno: ${answer.no}\n\nno is always enough, and nobody is told why.`
      : 'do you want to go out? ask your agent about swipeless to see who they are, then say yes or no. no is always enough, and nobody is told why.',
    SIGN_OFF,
  ].join('\n\n'),
  html: note(`${otherFirstName} would like to meet you.`, [
    hi(firstName),
    { hand: `${escapeHtml(otherFirstName)} would like to meet you.` },
    blank,
    ...whereLines(date),
    blank,
    { hand: 'do you want to go out?', size: 34 },
    {
      hand: `${checkbox('yes', answer?.yes)}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;${checkbox('no', answer?.no)}`,
      size: 34,
    },
    {
      print: answer
        ? 'tick one to see their photo and answer. no is always enough, and nobody is told why.'
        : 'tell your agent yes or no. ask it about swipeless to see who they are. no is always enough, and nobody is told why.',
    },
    blank,
    signOff,
  ]),
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
  html: note(`you and ${otherFirstName} both said yes.`, [
    hi(firstName),
    {
      hand: `you and ${escapeHtml(otherFirstName)} both said ${highlight('yes')}.`,
    },
    blank,
    ...whereLines(date),
    {
      hand: `${escapeHtml(otherFirstName)}'s number: ${highlight(escapeHtml(otherPhone))}`,
    },
    blank,
    { print: 'text them, call them, whatever feels right.' },
    { hand: 'have fun.' },
    blank,
    signOff,
  ]),
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
  html: note(`how was the date with ${otherFirstName}?`, [
    hi(firstName),
    { hand: `how was the date with ${escapeHtml(otherFirstName)}?`, size: 34 },
    blank,
    { print: 'just reply to this email, a line is plenty.' },
    {
      print:
        'it helps us find your next one, and if anything felt off, tell us. we read every reply.',
    },
    blank,
    signOff,
  ]),
})
