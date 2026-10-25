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
