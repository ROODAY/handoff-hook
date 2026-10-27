import { expect, test } from 'claude-code/testing'
import { acknowledgeSevenDay, evaluate, initialRelayState } from './state'
import type { Config } from './config'
import type { Snapshot } from './usage'

const NOW = 1_800_000_000_000
const cfg = (p: Partial<Config> = {}): Config => ({
  fiveHourThreshold: 90, resumeBelow: 5, sevenDayThreshold: 90, pollSeconds: 60,
  handoffFile: 'HANDOFF.md', claudeModel: 'c', deepseekModel: 'd', enabled: true,
  role: 'claude', fakeFiveHour: null, fakeSevenDay: null, terminal: 'wt', ...p,
})
const snap = (p: Partial<Snapshot> = {}): Snapshot => ({
  fiveHour: 50, fiveHourResetsAt: NOW + 3_600_000, sevenDay: 40,
  sevenDayResetsAt: NOW + 86_400_000, fetchedAt: NOW, source: 'endpoint',
  stale: false, ...p,
})
const base = (p: Partial<Parameters<typeof evaluate>[0]> = {}) => ({
  now: NOW, sessionId: 's1', role: 'claude' as const, config: cfg(),
  snapshot: snap(), state: initialRelayState, handoffMtimeMs: null,
  turnIdle: true, ...p,
})

test('below threshold does nothing', () => {
  const r = evaluate(base())
  expect(r.requestHandoff).toBeNull()
  expect(r.launch).toBeNull()
  expect(r.blocked).toBeNull()
})

test('crossing the 5h threshold claims the window and asks for a handoff', () => {
  const r = evaluate(base({ snapshot: snap({ fiveHour: 91 }) }))
  expect(r.requestHandoff).toEqual({ direction: 'to_deepseek' })
  expect(r.state.phase).toBe('handoff_pending')
  expect(r.state.owner).toBe('s1')
})

test('a second Claude session over the threshold neither claims nor is gated', () => {
  const owned = {
    ...initialRelayState, phase: 'handoff_pending' as const,
    owner: 'other', ownerSeenAt: NOW, windowKey: '5h:30000000',
  }
  const r = evaluate(base({
    sessionId: 's2', snapshot: snap({ fiveHour: 96, fiveHourResetsAt: NOW }), state: owned,
  }))
  expect(r.requestHandoff).toBeNull()
  expect(r.blocked).toBeNull()
})

test('the owner is gated while the handoff is unwritten, and launches once it is fresh', () => {
  const pending = {
    ...initialRelayState, phase: 'handoff_pending' as const,
    owner: 's1', ownerSeenAt: NOW, requestedAt: NOW - 1000, windowKey: '5h:30000000',
  }
  const gated = evaluate(base({ snapshot: snap({ fiveHour: 95, fiveHourResetsAt: NOW }), state: pending }))
  expect(gated.blocked).toEqual({ kind: 'handoff' })
  const launched = evaluate(base({
    snapshot: snap({ fiveHour: 95, fiveHourResetsAt: NOW }), state: pending,
    handoffMtimeMs: NOW, turnIdle: true,
  }))
  expect(launched.launch).toEqual({ target: 'deepseek' })
  expect(launched.state.phase).toBe('switched')
})

test('a running turn is not cut off: no launch while the turn is busy', () => {
  const pending = {
    ...initialRelayState, phase: 'handoff_pending' as const,
    owner: 's1', ownerSeenAt: NOW, requestedAt: NOW - 1000, windowKey: '5h:30000000',
  }
  const r = evaluate(base({
    snapshot: snap({ fiveHour: 95, fiveHourResetsAt: NOW }), state: pending,
    handoffMtimeMs: NOW, turnIdle: false,
  }))
  expect(r.launch).toBeNull()
})

test('a window already switched does not launch again', () => {
  const switched = {
    ...initialRelayState, phase: 'switched' as const, owner: 's1',
    ownerSeenAt: NOW, requestedAt: NOW - 1000, switchedAt: NOW,
    windowKey: '5h:30000000',
  }
  const r = evaluate(base({
    snapshot: snap({ fiveHour: 97, fiveHourResetsAt: NOW }), state: switched,
    handoffMtimeMs: NOW,
  }))
  expect(r.launch).toBeNull()
})

test('a new 5h window resets the phase to idle', () => {
  const switched = {
    ...initialRelayState, phase: 'switched' as const, owner: 's1',
    ownerSeenAt: NOW, windowKey: '5h:30000000',
  }
  const r = evaluate(base({
    snapshot: snap({ fiveHour: 10, fiveHourResetsAt: NOW + 7_200_000 }), state: switched,
  }))
  expect(r.state.phase).toBe('idle')
})

test('7d blocks tools, notifies once, and /relay resume acknowledges that window', () => {
  const over = snap({ sevenDay: 95 })
  const r = evaluate(base({ snapshot: over }))
  expect(r.blocked).toEqual({ kind: 'seven_day' })
  expect(r.notify).toMatch(/7-day/)
  const again = evaluate(base({ snapshot: over, state: r.state }))
  expect(again.notify).toBeNull()
  const acked = acknowledgeSevenDay(cfg(), over, r.state)
  expect(evaluate(base({ snapshot: over, state: acked })).blocked).toBeNull()
  const nextWeek = snap({ sevenDay: 95, sevenDayResetsAt: NOW + 8 * 86_400_000 })
  expect(evaluate(base({ snapshot: nextWeek, state: acked })).blocked).toEqual({ kind: 'seven_day' })
})

test('deepseek session is never gated and asks for a return after the reset', () => {
  const reset = snap({ fiveHour: 2, fiveHourResetsAt: NOW - 60_000 })
  const r = evaluate(base({ role: 'deepseek', snapshot: reset }))
  expect(r.blocked).toBeNull()
  expect(r.requestHandoff).toEqual({ direction: 'to_claude' })
  expect(r.state.phase).toBe('return_pending')
  const launched = evaluate(base({
    role: 'deepseek', snapshot: reset, state: r.state, handoffMtimeMs: NOW + 1,
  }))
  expect(launched.launch).toEqual({ target: 'claude' })
})

test('deepseek session does nothing while Claude is still capped', () => {
  const capped = snap({ fiveHour: 60, fiveHourResetsAt: NOW + 3_600_000 })
  const r = evaluate(base({ role: 'deepseek', snapshot: capped }))
  expect(r.requestHandoff).toBeNull()
  expect(r.launch).toBeNull()
})

test('a stale snapshot does nothing', () => {
  const r = evaluate(base({ snapshot: snap({ fiveHour: 99, stale: true }) }))
  expect(r.requestHandoff).toBeNull()
  expect(r.blocked).toBeNull()
})

test('a pause suppresses switching but never the tool gate', () => {
  const paused = { ...initialRelayState, pausedUntil: NOW + 60_000 }
  const r = evaluate(base({ snapshot: snap({ fiveHour: 99 }), state: paused }))
  expect(r.requestHandoff).toBeNull()
  expect(r.launch).toBeNull()
  expect(r.blocked).toEqual({ kind: 'handoff' })
})

test('an expired lease lets another session take the window over', () => {
  const owned = {
    ...initialRelayState, phase: 'handoff_pending' as const,
    owner: 'dead', ownerSeenAt: NOW - 700_000, requestedAt: NOW - 700_000,
    windowKey: '5h:30000000',
  }
  const r = evaluate(base({
    sessionId: 's2', snapshot: snap({ fiveHour: 95, fiveHourResetsAt: NOW }), state: owned,
  }))
  expect(r.state.owner).toBe('s2')
  expect(r.blocked).toEqual({ kind: 'handoff' })
})

test('a real post-reset reading (future reset time, usage 0) returns to Claude', () => {
  const afterReset = snap({ fiveHour: 0.5, fiveHourResetsAt: NOW + 5 * 3_600_000 })
  const r = evaluate(base({ role: 'deepseek', snapshot: afterReset }))
  expect(r.requestHandoff).toEqual({ direction: 'to_claude' })
})

test('after a completed return, the next outbound window still claims and gates', () => {
  const reset = snap({ fiveHour: 0, fiveHourResetsAt: NOW - 60_000 })
  const returned = evaluate(base({ role: 'deepseek', snapshot: reset }))
  const done = evaluate(base({
    role: 'deepseek', snapshot: reset, state: returned.state, handoffMtimeMs: NOW + 1,
  }))
  expect(done.launch).toEqual({ target: 'claude' })
  const nextWindow = snap({ fiveHour: 92, fiveHourResetsAt: NOW + 10 * 3_600_000 })
  const claude = evaluate(base({ snapshot: nextWindow, state: done.state }))
  expect(claude.requestHandoff).toEqual({ direction: 'to_deepseek' })
  expect(claude.state.owner).toBe('s1')
})

test('a Claude session claims again in the same window after a return left the state returned', () => {
  const returnedState = {
    ...initialRelayState, phase: 'returned' as const, owner: 'deepseek-1',
    ownerSeenAt: NOW, windowKey: '5h:30000000',
  }
  const r = evaluate(base({
    snapshot: snap({ fiveHour: 93, fiveHourResetsAt: NOW }), state: returnedState,
  }))
  expect(r.requestHandoff).toEqual({ direction: 'to_deepseek' })
  expect(r.blocked).toEqual({ kind: 'handoff' })
})

test('a 7d acknowledgement survives a key that drifts across the rounding boundary', () => {
  const over = snap({ sevenDay: 95, sevenDayResetsAt: NOW })
  const first = evaluate(base({ snapshot: over }))
  const acked = acknowledgeSevenDay(cfg(), over, first.state)
  const drifted = snap({ sevenDay: 95, sevenDayResetsAt: NOW + 30_000 })
  expect(evaluate(base({ snapshot: drifted, state: acked })).blocked).toBeNull()
})

test('a stale snapshot keeps an in-flight handoff gate armed', () => {
  const pending = {
    ...initialRelayState, phase: 'handoff_pending' as const, owner: 's1',
    ownerSeenAt: NOW, requestedAt: NOW - 1000, windowKey: '5h:30000000',
  }
  const r = evaluate(base({
    snapshot: snap({ fiveHour: 95, fiveHourResetsAt: NOW, stale: true }), state: pending,
  }))
  expect(r.blocked).toEqual({ kind: 'handoff' })
})
