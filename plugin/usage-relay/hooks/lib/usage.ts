import type { SessionRateLimit } from 'claude-code'

export type Snapshot = {
  fiveHour: number | null
  fiveHourResetsAt: number | null
  sevenDay: number | null
  sevenDayResetsAt: number | null
  fetchedAt: number
  source: 'session' | 'endpoint' | 'fake'
  stale: boolean
}

function pct(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function epoch(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

export function parseUsageResponse(text: string, now: number): Snapshot | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  const five = b.five_hour as Record<string, unknown> | undefined
  const seven = b.seven_day as Record<string, unknown> | undefined
  const fiveHour = pct(five?.utilization)
  const sevenDay = pct(seven?.utilization)
  if (fiveHour === null && sevenDay === null) return null
  return {
    fiveHour,
    fiveHourResetsAt: epoch(five?.resets_at),
    sevenDay,
    sevenDayResetsAt: epoch(seven?.resets_at),
    fetchedAt: now,
    source: 'endpoint',
    stale: false,
  }
}

export function fromSessionRateLimits(
  limits: readonly SessionRateLimit[],
  now: number,
): Snapshot | null {
  const five = limits.find(l => l.kind === 'five_hour')
  const seven = limits.find(l => l.kind === 'seven_day')
  if (!five && !seven) return null
  return {
    fiveHour: five ? pct(five.percentUsed) : null,
    fiveHourResetsAt: epoch(five?.resetsAt),
    sevenDay: seven ? pct(seven.percentUsed) : null,
    sevenDayResetsAt: epoch(seven?.resetsAt),
    fetchedAt: now,
    source: 'session',
    stale: false,
  }
}

export function fakeSnapshot(
  config?: { fakeFiveHour: number | null; fakeSevenDay: number | null },
  now: number = 0,
): Snapshot | null {
  if (!config) return null
  if (config.fakeFiveHour === null && config.fakeSevenDay === null) return null
  return {
    fiveHour: config.fakeFiveHour,
    fiveHourResetsAt: null,
    sevenDay: config.fakeSevenDay,
    sevenDayResetsAt: null,
    fetchedAt: now,
    source: 'fake',
    stale: false,
  }
}

export function readToken(credentialsText: string, now: number): string | null {
  let body: unknown
  try {
    body = JSON.parse(credentialsText)
  } catch {
    return null
  }
  const o = (body as Record<string, unknown> | null)?.claudeAiOauth as
    | Record<string, unknown>
    | undefined
  const token = o?.accessToken
  const expiresAt = o?.expiresAt
  if (typeof token !== 'string' || token.length === 0) return null
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null
  return expiresAt - now > 120_000 ? token : null
}

export function nextUsage(previous: Snapshot | null, text: string | null, now: number): Snapshot | null {
  const fresh = typeof text === 'string' ? parseUsageResponse(text, now) : null
  if (fresh) return fresh
  return previous ? { ...previous, stale: true } : null
}

export function fiveHourKey(s: Snapshot): string {
  return s.fiveHourResetsAt === null ? '5h:none' : `5h:${Math.round(s.fiveHourResetsAt / 60_000)}`
}

export function sevenDayKey(s: Snapshot): string {
  return s.sevenDayResetsAt === null ? '7d:none' : `7d:${Math.round(s.sevenDayResetsAt / 60_000)}`
}

export function sameWindow(a: string, b: string, toleranceMs: number): boolean {
  if (a === b) return true
  const na = Number(a.slice(a.indexOf(':') + 1))
  const nb = Number(b.slice(b.indexOf(':') + 1))
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false
  return Math.abs(na - nb) * 60_000 <= toleranceMs
}

// One usage fetch per interval for the whole machine: every session reads and
// writes this gate through the plugin store, so N open sessions cost one call.
export type FetchGate = {
  lastAttemptAt: number
  backoffUntil: number
  failures: number
  lastError: string | null
}

export const initialFetchGate: FetchGate = {
  lastAttemptAt: 0,
  backoffUntil: 0,
  failures: 0,
  lastError: null,
}

const BACKOFF_BASE_MS = 60_000
const BACKOFF_CAP_MS = 15 * 60_000

export function planUsageFetch(now: number, gate: FetchGate, intervalMs: number): 'fetch' | 'reuse' {
  if (now < gate.backoffUntil) return 'reuse'
  if (now - gate.lastAttemptAt < intervalMs) return 'reuse'
  return 'fetch'
}

export function afterUsageFetch(
  gate: FetchGate,
  now: number,
  outcome: { ok: boolean; status: number; retryAfterMs: number },
): FetchGate {
  if (outcome.ok) return { lastAttemptAt: now, backoffUntil: 0, failures: 0, lastError: null }
  const failures = gate.failures + 1
  const computed = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1))
  const wait = Math.max(computed, outcome.retryAfterMs)
  return {
    lastAttemptAt: now,
    backoffUntil: now + wait,
    failures,
    lastError: outcome.status > 0 ? `usage endpoint ${outcome.status}` : 'usage endpoint unreachable',
  }
}

export function describeFetchGate(gate: FetchGate, now: number): string | null {
  if (!gate.lastError) return null
  const left = gate.backoffUntil - now
  if (left <= 0) return gate.lastError
  return `${gate.lastError}, retry in ${Math.ceil(left / 60_000)}m`
}

export function isFetchGate(value: unknown): value is FetchGate {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.lastAttemptAt === 'number' && typeof v.backoffUntil === 'number' && typeof v.failures === 'number'
}
