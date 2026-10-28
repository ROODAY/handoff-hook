import { expect, test } from 'claude-code/testing'
import { readMeter, staleReading } from './meters'
import type { ChainStep } from './chain'
import type { Snapshot } from './usage'

const NOW = 1_800_000_000_000
const claude: ChainStep = {
  id: 'claude', label: 'Claude', model: 'm',
  meter: { type: 'claude-oauth', exhaust_at: { five_hour: 90 }, pause_at: { seven_day: 90 }, resume_below: { five_hour: 5 } },
}
const deepseek: ChainStep = {
  id: 'deepseek', label: 'DeepSeek', model: 'm',
  meter: { type: 'deepseek-balance', api_key_env: 'DEEPSEEK_API_KEY',
    exhaust_below: { amount: 2, currency: 'USD' }, resume_above: { amount: 3, currency: 'USD' } },
}
const spend: ChainStep = { id: 'spend', label: 'S', model: 'm', meter: { type: 'session-spend', exhaust_at_usd: 2 } }
const snap = (p: Partial<Snapshot> = {}): Snapshot => ({
  fiveHour: 50, fiveHourResetsAt: NOW + 3_600_000, sevenDay: 40, sevenDayResetsAt: NOW + 86_400_000,
  fetchedAt: NOW, source: 'endpoint', stale: false, ...p,
})
const base = { usage: null, balances: {}, spendUsd: null, isCurrent: true }
const usd = (amount: number) => ({ balance_infos: [{ currency: 'USD', total_balance: String(amount) }] })

test('claude: over the 5h threshold is exhausted', () => {
  const r = readMeter(claude, { ...base, usage: snap({ fiveHour: 95 }) }, NOW)
  expect(r.exhausted).toBe(true)
  expect(r.gate).toBeNull()
  expect(r.summary).toContain('5h 95')
})

test('claude: a 7d breach gates but does not exhaust', () => {
  const r = readMeter(claude, { ...base, usage: snap({ fiveHour: 10, sevenDay: 96 }) }, NOW)
  expect(r.exhausted).toBe(false)
  expect(r.gate?.kind).toBe('seven_day')
  expect(r.gate?.detail).toContain('96')
  expect(r.available).toBe(false)
})

test('claude: below resume is available, the band is neither', () => {
  expect(readMeter(claude, { ...base, usage: snap({ fiveHour: 3 }) }, NOW).available).toBe(true)
  const band = readMeter(claude, { ...base, usage: snap({ fiveHour: 50 }) }, NOW)
  expect(band.available).toBe(false)
  expect(band.exhausted).toBe(false)
})

test('claude: a stale snapshot is stale, never exhausted', () => {
  const r = readMeter(claude, { ...base, usage: snap({ fiveHour: 99, stale: true }) }, NOW)
  expect(r.stale).toBe(true)
  expect(r.exhausted).toBe(false)
})

test('deepseek: balance drives exhausted and available', () => {
  expect(readMeter(deepseek, { ...base, balances: { DEEPSEEK_API_KEY: usd(1.5) } }, NOW).exhausted).toBe(true)
  expect(readMeter(deepseek, { ...base, balances: { DEEPSEEK_API_KEY: usd(4) } }, NOW).available).toBe(true)
  const band = readMeter(deepseek, { ...base, balances: { DEEPSEEK_API_KEY: usd(2.5) } }, NOW)
  expect([band.exhausted, band.available]).toEqual([false, false])
})

test('deepseek: a missing key or currency is stale and names what is wrong', () => {
  expect(readMeter(deepseek, base, NOW).stale).toBe(true)
  const cny = readMeter(deepseek, { ...base, balances: { DEEPSEEK_API_KEY: { balance_infos: [{ currency: 'CNY', total_balance: '10' }] } } }, NOW)
  expect(cny.stale).toBe(true)
  expect(cny.summary).toContain('CNY')
})

test('session spend is read only for the current step', () => {
  expect(readMeter(spend, { ...base, spendUsd: 2.5 }, NOW).exhausted).toBe(true)
  const other = readMeter(spend, { ...base, spendUsd: 2.5, isCurrent: false }, NOW)
  expect([other.exhausted, other.available, other.summary]).toEqual([false, true, 'session spend (n/a)'])
})

test('a stale reading is never exhausted or available', () => {
  const r = staleReading('no key', NOW)
  expect([r.exhausted, r.available, r.stale]).toEqual([false, false, true])
})
