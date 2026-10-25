import { expect, test } from 'bun:test'
import { cleanFit } from '../src/fit-writer.ts'

test('a model answer becomes one clean line', () => {
  expect(cleanFit('  "you both swim\n in the sea."  ')).toBe(
    'you both swim in the sea.'
  )
  expect(cleanFit('   ')).toBeUndefined()
  const long = cleanFit('a'.repeat(500))
  expect(long?.length).toBe(320)
  expect(long?.endsWith('…')).toBe(true)
})

test('a line that would disclose contact details is dropped', () => {
  for (const leak of [
    'text them at +354 822 1234, they love hiking.',
    'you both hike; reach them at sigrun@example.com.',
    'see their pics on https://example.com/sigrun.',
    'you both love sigrun.me, apparently.',
  ]) {
    expect(cleanFit(leak)).toBeUndefined()
  }
  expect(cleanFit('you both swim at 7 every morning.')).toBe(
    'you both swim at 7 every morning.'
  )
})
