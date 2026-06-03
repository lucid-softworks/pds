import { describe, expect, it } from 'vitest'
import { relativeTime } from './relativeTime'

const NOW = new Date('2026-06-01T12:00:00.000Z')

describe('relativeTime', () => {
  it('handles seconds', () => {
    expect(relativeTime(new Date(NOW.getTime() - 30_000), NOW)).toBe('30s ago')
  })

  it('returns "just now" within 5 seconds', () => {
    expect(relativeTime(new Date(NOW.getTime() - 2_000), NOW)).toBe('just now')
  })

  it('handles minutes', () => {
    expect(relativeTime(new Date(NOW.getTime() - 5 * 60_000), NOW)).toBe('5m ago')
  })

  it('handles hours', () => {
    expect(relativeTime(new Date(NOW.getTime() - 3 * 60 * 60_000), NOW)).toBe('3h ago')
  })

  it('handles days', () => {
    expect(relativeTime(new Date(NOW.getTime() - 2 * 24 * 60 * 60_000), NOW)).toBe('2d ago')
  })

  it('handles weeks', () => {
    expect(relativeTime(new Date(NOW.getTime() - 14 * 24 * 60 * 60_000), NOW)).toBe('2w ago')
  })

  it('handles future timestamps gracefully', () => {
    expect(relativeTime(new Date(NOW.getTime() + 60_000), NOW)).toBe('in the future')
  })

  it('handles unparseable input gracefully', () => {
    expect(relativeTime('not a date', NOW)).toBe('unknown time')
  })

  it('accepts ISO strings', () => {
    expect(relativeTime('2026-06-01T11:00:00.000Z', NOW)).toBe('1h ago')
  })
})
