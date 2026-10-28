import type { ChainStep } from './chain'
import { fiveHourKey, sevenDayKey, type Snapshot } from './usage'

export type MeterReading = {
  exhausted: boolean
  available: boolean
  gate: { kind: 'seven_day'; detail: string } | null
  summary: string
  fetchedAt: number
  stale: boolean
  fiveHourKey: string
  sevenDayKey: string
}

export type MeterInputs = {
  usage: Snapshot | null
  balances: Record<string, unknown>
  spendUsd: number | null
  isCurrent: boolean
}

const EMPTY_KEYS = { fiveHourKey: '', sevenDayKey: '' }

export function staleReading(summary: string, now: number): MeterReading {
  return {
    exhausted: false,
    available: false,
    gate: null,
    summary,
    fetchedAt: now,
    stale: true,
    ...EMPTY_KEYS,
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function numberAt(source: unknown, path: string[]): number | null {
  let cursor: unknown = source
  for (const key of path) {
    if (!isRecord(cursor)) return null
    cursor = cursor[key]
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : null
}

function claudeReading(step: ChainStep, inputs: MeterInputs, now: number): MeterReading {
  const usage = inputs.usage
  if (!usage || usage.stale) return staleReading('usage unavailable', now)
  const five = usage.fiveHour
  const seven = usage.sevenDay
  const exhaustAt = numberAt(step.meter, ['exhaust_at', 'five_hour']) ?? 90
  const pauseAt = numberAt(step.meter, ['pause_at', 'seven_day'])
  const resumeAt = numberAt(step.meter, ['resume_below', 'five_hour'])

  const exhausted = five !== null && five >= exhaustAt
  const gate =
    pauseAt !== null && seven !== null && seven >= pauseAt
      ? {
          kind: 'seven_day' as const,
          detail: `Weekly usage is at ${Math.round(seven)}% of the 7-day cap. Work paused; run /relay resume or wait for the reset.`,
        }
      : null
  const available =
    !gate &&
    five !== null &&
    resumeAt !== null &&
    five <= resumeAt &&
    (pauseAt === null || seven === null || seven < pauseAt)

  return {
    exhausted,
    available,
    gate,
    summary: `5h ${five === null ? '?' : Math.round(five)}% · 7d ${seven === null ? '?' : Math.round(seven)}%`,
    fetchedAt: now,
    stale: false,
    fiveHourKey: fiveHourKey(usage),
    sevenDayKey: sevenDayKey(usage),
  }
}

function deepseekReading(step: ChainStep, inputs: MeterInputs, now: number): MeterReading {
  const env = String(step.meter.api_key_env ?? '')
  const body = inputs.balances[env]
  if (body === undefined || body === null) return staleReading(`no key: ${env}`, now)
  if (!isRecord(body)) return staleReading('balance response unreadable', now)

  const wanted = isRecord(step.meter.exhaust_below)
    ? String(step.meter.exhaust_below.currency ?? '')
    : ''
  const infos = Array.isArray(body.balance_infos) ? body.balance_infos : []
  const match = infos.find(
    entry => isRecord(entry) && String(entry.currency ?? '').toLowerCase() === wanted.toLowerCase(),
  )
  if (!isRecord(match)) {
    const present = infos
      .filter(isRecord)
      .map(entry => String(entry.currency ?? '?'))
      .join(', ')
    return staleReading(`no ${wanted} balance; currencies: ${present || 'none'}`, now)
  }
  const amount = Number(match.total_balance)
  if (!Number.isFinite(amount)) return staleReading('balance unreadable', now)

  const below = numberAt(step.meter, ['exhaust_below', 'amount'])
  const above = numberAt(step.meter, ['resume_above', 'amount'])
  const exhaustBelow = below ?? 0
  const resumeAbove = above ?? exhaustBelow + 1

  return {
    exhausted: amount < exhaustBelow,
    available: amount >= resumeAbove,
    gate: null,
    summary: `$${amount.toFixed(2)} left`,
    fetchedAt: now,
    stale: false,
    ...EMPTY_KEYS,
  }
}

function spendReading(step: ChainStep, inputs: MeterInputs, now: number): MeterReading {
  if (!inputs.isCurrent) {
    return {
      exhausted: false,
      available: true,
      gate: null,
      summary: 'session spend (n/a)',
      fetchedAt: now,
      stale: false,
      ...EMPTY_KEYS,
    }
  }
  if (inputs.spendUsd === null) return staleReading('session cost unavailable', now)
  const limit = numberAt(step.meter, ['exhaust_at_usd']) ?? Number.POSITIVE_INFINITY
  return {
    exhausted: inputs.spendUsd >= limit,
    available: true,
    gate: null,
    summary: `session $${inputs.spendUsd.toFixed(2)}`,
    fetchedAt: now,
    stale: false,
    ...EMPTY_KEYS,
  }
}

export function readMeter(step: ChainStep, inputs: MeterInputs, now: number): MeterReading {
  switch (step.meter.type) {
    case 'claude-oauth':
      return claudeReading(step, inputs, now)
    case 'deepseek-balance':
      return deepseekReading(step, inputs, now)
    case 'session-spend':
      return spendReading(step, inputs, now)
    default:
      return staleReading(`unknown meter ${String(step.meter.type)}`, now)
  }
}
