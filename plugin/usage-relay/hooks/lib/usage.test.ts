import { expect, test } from 'claude-code/testing'
import { fiveHourKey, fromSessionRateLimits, parseUsageResponse, readToken, sameWindow } from './usage'

const NOW = 1_800_000_000_000
const BODY = JSON.stringify({
  five_hour: { utilization: 53, resets_at: '2026-10-28T02:30:00.299525+00:00' },
  seven_day: { utilization: 66, resets_at: '2026-10-30T04:00:00.299549+00:00' },
})

test('parses utilization and reset times from the endpoint body', () => {
  const s = parseUsageResponse(BODY, NOW)
  expect(s?.fiveHour).toBe(53)
  expect(s?.sevenDay).toBe(66)
  expect(s?.fiveHourResetsAt).toBe(Date.parse('2026-10-28T02:30:00.299525+00:00'))
  expect(s?.stale).toBe(false)
})

test('returns null for a body with no windows or bad JSON', () => {
  expect(parseUsageResponse('{}', NOW)).toBeNull()
  expect(parseUsageResponse('not json', NOW)).toBeNull()
})

test('reads the session rate limits', () => {
  const s = fromSessionRateLimits([
    { kind: 'five_hour', percentUsed: 91.5, resetsAt: '2026-10-28T02:30:00Z' },
  ], NOW)
  expect(s?.fiveHour).toBe(91.5)
  expect(s?.sevenDay).toBeNull()
  expect(s?.source).toBe('session')
})

test('a reset time that drifts under a second keeps the same window key', () => {
  const a = parseUsageResponse(BODY, NOW)!
  const b = parseUsageResponse(JSON.stringify({
    five_hour: { utilization: 54, resets_at: '2026-10-28T02:30:00.600000+00:00' },
  }), NOW)!
  expect(fiveHourKey(b)).toBe(fiveHourKey(a))
})

test('a key that drifts across the minute boundary is still the same window', () => {
  const a = parseUsageResponse(JSON.stringify({
    five_hour: { utilization: 53, resets_at: '2026-10-28T02:29:59.894982+00:00' },
  }), NOW)!
  const b = parseUsageResponse(JSON.stringify({
    five_hour: { utilization: 54, resets_at: '2026-10-28T02:30:00.219197+00:00' },
  }), NOW)!
  expect(sameWindow(fiveHourKey(a), fiveHourKey(b), 60_000)).toBe(true)
  expect(sameWindow('5h:1', '5h:6', 60_000)).toBe(false)
  expect(sameWindow('5h:none', '5h:6', 60_000)).toBe(false)
})

test('a window with no reset time keys as none', () => {
  const s = fromSessionRateLimits([{ kind: 'five_hour', percentUsed: 99 }], NOW)!
  expect(fiveHourKey(s)).toBe('5h:none')
})

test('a token is used only while it has more than two minutes left', () => {
  const creds = (expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt } })
  expect(readToken(creds(NOW + 600_000), NOW)).toBe('tok')
  expect(readToken(creds(NOW + 60_000), NOW)).toBeNull()
  expect(readToken(creds(NOW - 1), NOW)).toBeNull()
  expect(readToken('{}', NOW)).toBeNull()
  expect(readToken('not json', NOW)).toBeNull()
})
