import { expect, test } from 'vitest'
import { formatTokenCount } from './tokenFormat'

test('a count under a thousand reads whole', () => {
  expect(formatTokenCount(0)).toBe('0')
  expect(formatTokenCount(850)).toBe('850')
  expect(formatTokenCount(950.4)).toBe('950')
})

test('thousands carry one decimal under a hundred, never a trailing .0', () => {
  expect(formatTokenCount(4_500)).toBe('4.5k')
  expect(formatTokenCount(8_000)).toBe('8k')
  expect(formatTokenCount(12_345)).toBe('12.3k')
  expect(formatTokenCount(84_000)).toBe('84k')
  expect(formatTokenCount(182_000)).toBe('182k')
  expect(formatTokenCount(200_000)).toBe('200k')
})

test('a count that would round to 1000k reads in millions', () => {
  expect(formatTokenCount(999_700)).toBe('1M')
  expect(formatTokenCount(999_800)).toBe('1M')
  expect(formatTokenCount(1_000_000)).toBe('1M')
  expect(formatTokenCount(1_240_000)).toBe('1.2M')
  expect(formatTokenCount(1_250_000)).toBe('1.3M')
})

test('a negative or non-finite count reads as zero', () => {
  expect(formatTokenCount(-5)).toBe('0')
  expect(formatTokenCount(Number.NaN)).toBe('0')
  expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe('0')
})
