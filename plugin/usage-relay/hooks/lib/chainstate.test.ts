import { expect, test } from 'claude-code/testing'
import { evaluateChain, initialChainState, isStaleLock, lockKeyFor, moveTo } from './chainstate'
import type { Chain } from './chain'
import type { MeterReading } from './meters'

const NOW = 1_800_000_000_000
const R = (p: Partial<MeterReading> = {}): MeterReading => ({
  exhausted: false, available: false, gate: null, summary: '', fetchedAt: NOW,
  stale: false, fiveHourKey: '5h:1', sevenDayKey: '7d:1', ...p,
})
const chain: Chain = {
  id: 'c1',
  steps: [
    { id: 'claude', label: 'Claude', model: 'cm', meter: { type: 'claude-oauth' } },
    { id: 'deepseek', label: 'DeepSeek', model: 'dm', meter: { type: 'deepseek-balance' } },
  ],
}
const base = (p: Partial<Parameters<typeof evaluateChain>[0]> = {}) => ({
  now: NOW, sessionId: 's1', stepId: 'claude', chain,
  state: { ...initialChainState, chainId: 'c1' },
  readings: { claude: R(), deepseek: R() },
  turnIdle: true, handoffMtimeMs: null, ...p,
})

test('a step in its hysteresis band stays put', () => {
  const r = evaluateChain(base({
    stepId: 'deepseek',
    readings: { claude: R({ exhausted: true }), deepseek: R({ exhausted: false, available: false }) },
  }))
  expect(r.requestHandoff).toBeNull()
  expect(r.notify).toBeNull()
})

test('an exhausted current step moves to the next usable step', () => {
  const r = evaluateChain(base({
    readings: { claude: R({ exhausted: true }), deepseek: R({ exhausted: false }) },
  }))
  expect(r.requestHandoff).toEqual({ from: 'claude', to: 'deepseek' })
  expect(r.state.phase).toBe('handoff_pending')
})

test('a preferred step becoming available moves the chain back', () => {
  const r = evaluateChain(base({
    stepId: 'deepseek',
    readings: { claude: R({ available: true }), deepseek: R() },
  }))
  expect(r.requestHandoff).toEqual({ from: 'deepseek', to: 'claude' })
})

test('a 7-day gate blocks and never moves', () => {
  const r = evaluateChain(base({
    readings: { claude: R({ gate: { kind: 'seven_day', detail: 'Weekly 96%' } }), deepseek: R() },
  }))
  expect(r.blocked).toEqual({ kind: 'seven_day', detail: 'Weekly 96%' })
  expect(r.requestHandoff).toBeNull()
})

test('a stale current reading stays put; a stale preferred step is not eligible', () => {
  expect(evaluateChain(base({ readings: { claude: R({ stale: true }), deepseek: R() } })).requestHandoff).toBeNull()
  const back = evaluateChain(base({
    stepId: 'deepseek',
    readings: { claude: R({ available: true, stale: true }), deepseek: R() },
  }))
  expect(back.requestHandoff).toBeNull()
})

test('all steps exhausted notifies once per chain state', () => {
  const readings = { claude: R({ exhausted: true }), deepseek: R({ exhausted: true }) }
  const first = evaluateChain(base({ readings }))
  expect(first.requestHandoff).toBeNull()
  expect(first.notify).toMatch(/exhausted/i)
  const again = evaluateChain(base({ readings, state: first.state }))
  expect(again.notify).toBeNull()
})

test('the handoff launches only when fresh and idle, then stays inert', () => {
  const pending = evaluateChain(base({
    readings: { claude: R({ exhausted: true }), deepseek: R() },
  })).state
  const readings = { claude: R({ exhausted: true }), deepseek: R() }
  const busy = evaluateChain(base({ state: pending, readings, handoffMtimeMs: NOW, turnIdle: false }))
  expect(busy.launch).toBeNull()
  const launched = evaluateChain(base({ state: pending, readings, handoffMtimeMs: NOW, turnIdle: true }))
  expect(launched.launch).toEqual({ stepId: 'deepseek' })
  expect(launched.state.phase).toBe('switched')
  const after = evaluateChain(base({
    state: launched.state, handoffMtimeMs: NOW,
    readings: { claude: R({ exhausted: true }), deepseek: R() },
  }))
  expect(after.launch).toBeNull()
  expect(after.requestHandoff).toBeNull()
})

test('a different chain id resets the state', () => {
  const r = evaluateChain(base({ chain: { ...chain, id: 'c2' } }))
  expect(r.state.chainId).toBe('c2')
  expect(r.state.phase).toBe('idle')
  expect(r.state.owner).toBeNull()
})

test('a pause suppresses moves but never the gate', () => {
  const paused = { ...initialChainState, chainId: 'c1', pausedUntil: NOW + 60_000 }
  const r = evaluateChain(base({
    state: paused,
    readings: { claude: R({ exhausted: true, gate: { kind: 'seven_day', detail: 'Weekly 96%' } }), deepseek: R() },
  }))
  expect(r.requestHandoff).toBeNull()
  expect(r.blocked).not.toBeNull()
})

test('an expired lease lets another session take the move', () => {
  const owned = {
    ...initialChainState, chainId: 'c1', phase: 'handoff_pending' as const,
    owner: 'dead', ownerSeenAt: NOW - 700_000, requestedAt: NOW - 700_000,
    fromStepId: 'claude', toStepId: 'deepseek',
  }
  const r = evaluateChain(base({
    sessionId: 's2', state: owned,
    readings: { claude: R({ exhausted: true }), deepseek: R() },
  }))
  expect(r.state.owner).toBe('s2')
})

test('moveTo forces a direction for the slash command', () => {
  const s = moveTo({ ...initialChainState, chainId: 'c1' }, 'claude', 'deepseek', NOW, 's1')
  expect([s.phase, s.fromStepId, s.toStepId, s.requestedAt, s.owner])
    .toEqual(['handoff_pending', 'claude', 'deepseek', NOW, 's1'])
})

test('a lock key names the move and a lock older than the lease is stale', () => {
  const state = { ...initialChainState, chainId: 'c1', fromStepId: 'claude', toStepId: 'deepseek', windowKey: '5h:30000000' }
  expect(lockKeyFor(state)).toBe('c1-claude-deepseek-5h-30000000')
  expect(isStaleLock(null, NOW, 180_000)).toBe(false)
  expect(isStaleLock(NOW - 200_000, NOW, 180_000)).toBe(true)
  expect(isStaleLock(NOW - 60_000, NOW, 180_000)).toBe(false)
})


