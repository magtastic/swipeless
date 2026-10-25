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
