import { expect, test } from 'bun:test'
import {
  dateConfirmed,
  dateRequested,
  formatDateTime,
  howWasTheDate,
  profileApproved,
} from '../src/index.ts'

const date = {
  venue: { name: 'Kaffihús Vesturbæjar', address: 'Melhagi 20, 107 Reykjavík' },
  time: '2026-10-29T19:30:00.000Z',
}

test('formats the date time in Reykjavík', () => {
  expect(formatDateTime(date.time)).toBe('Thursday 29 October at 19:30')
})

test('the approval email greets them and promises nothing to do', () => {
  const email = profileApproved('anna@example.com', 'Anna')
  expect(email.to).toBe('anna@example.com')
  expect(email.text).toStartWith('hi Anna,')
  expect(email.text).toContain('go live your life')
})

test('the date request names the other person, place and time, no phone', () => {
  const email = dateRequested('anna@example.com', 'Anna', 'Jón', date)
  expect(email.subject).toBe('Jón would like to meet you')
  expect(email.text).toContain('Kaffihús Vesturbæjar, Melhagi 20')
  expect(email.text).toContain('Thursday 29 October at 19:30')
  expect(email.text).not.toMatch(/\+\d/)
})

test('the confirmation carries the other phone number', () => {
  const email = dateConfirmed(
    'anna@example.com',
    'Anna',
    'Jón',
    '+354 555 0101',
    date
  )
  expect(email.text).toContain("Jón's number: +354 555 0101")
})

test('the follow-up asks how the date was', () => {
  const email = howWasTheDate('anna@example.com', 'Anna', 'Jón')
  expect(email.subject).toBe('how was the date?')
  expect(email.text).toContain('how was the date with Jón?')
})

test('the note escapes names, and the date request links its boxes', () => {
  const email = dateRequested(
    'a@example.com',
    '<b>Anna</b>',
    'Jón & co',
    date,
    {
      yes: 'https://x.test/answer?choice=yes&sig=1',
      no: 'https://x.test/answer?choice=no&sig=1',
    }
  )
  expect(email.html).toContain('&lt;b&gt;Anna&lt;/b&gt;')
  expect(email.html).not.toContain('<b>Anna</b>')
  expect(email.html).toContain('Jón &amp; co would like to meet you.')
  expect(email.html).toContain(
    'href="https://x.test/answer?choice=yes&amp;sig=1"'
  )
  expect(email.text).toContain('yes: https://x.test/answer?choice=yes&sig=1')
})

test('every email carries the handwritten note', () => {
  for (const email of [
    profileApproved('a@example.com', 'Anna'),
    dateRequested('a@example.com', 'Anna', 'Jón', date),
    dateConfirmed('a@example.com', 'Anna', 'Jón', '+354 555 0101', date),
    howWasTheDate('a@example.com', 'Anna', 'Jón'),
  ]) {
    expect(email.html).toContain('xo, swipeless')
  }
})
