import { expect, test } from 'claude-code/testing'
import {
  afterUsageFetch, describeFetchGate, fiveHourKey, fromSessionRateLimits, initialFetchGate,
  nextUsage, parseUsageResponse, planUsageFetch, readToken, sameWindow,
} from './usage'

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

test('a failed read keeps the old numbers but marks them stale', () => {
  const good = parseUsageResponse(BODY, NOW)!
  expect(nextUsage(good, null, NOW)?.stale).toBe(true)
  expect(nextUsage(good, null, NOW)?.fiveHour).toBe(53)
  expect(nextUsage(null, 'not json', NOW)).toBeNull()
  expect(nextUsage(good, BODY, NOW)?.stale).toBe(false)
})

test('a shared gate allows one fetch per interval across sessions', () => {
  const gate = { ...initialFetchGate, lastAttemptAt: NOW - 30_000 }
  expect(planUsageFetch(NOW, gate, 60_000)).toBe('reuse')
  expect(planUsageFetch(NOW + 31_000, gate, 60_000)).toBe('fetch')
  expect(planUsageFetch(NOW, initialFetchGate, 60_000)).toBe('fetch')
})

test('failures back off exponentially up to fifteen minutes, success resets', () => {
  let gate = initialFetchGate
  const waits: number[] = []
  for (let i = 0; i < 6; i++) {
    gate = afterUsageFetch(gate, NOW, { ok: false, status: 429, retryAfterMs: 0 })
    waits.push(gate.backoffUntil - NOW)
  }
  expect(waits).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000])
  expect(planUsageFetch(NOW + 899_000, gate, 60_000)).toBe('reuse')
  expect(gate.lastError).toBe('usage endpoint 429')
  const ok = afterUsageFetch(gate, NOW, { ok: true, status: 200, retryAfterMs: 0 })
  expect([ok.failures, ok.backoffUntil, ok.lastError]).toEqual([0, 0, null])
})

test('a longer retry-after wins over the computed backoff', () => {
  const gate = afterUsageFetch(initialFetchGate, NOW, { ok: false, status: 429, retryAfterMs: 600_000 })
  expect(gate.backoffUntil - NOW).toBe(600_000)
})

test('the gate explains itself while backing off', () => {
  const gate = afterUsageFetch(initialFetchGate, NOW, { ok: false, status: 429, retryAfterMs: 0 })
  expect(describeFetchGate(gate, NOW + 15_000)).toBe('usage endpoint 429, retry in 1m')
  expect(describeFetchGate(initialFetchGate, NOW)).toBeNull()
})
