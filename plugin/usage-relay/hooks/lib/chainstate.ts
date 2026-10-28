import type { Chain } from './chain'
import type { MeterReading } from './meters'
import { sameWindow } from './usage'

export type ChainPhase = 'idle' | 'handoff_pending' | 'switched'

export type ChainState = {
  chainId: string
  windowKey: string
  phase: ChainPhase
  owner: string | null
  ownerSeenAt: number
  requestedAt: number | null
  fromStepId: string | null
  toStepId: string | null
  pausedUntil: number
  sevenDayAck: string | null
  notifiedAll: string | null
  notifiedSevenDay: string | null
  forced: boolean
}

export const initialChainState: ChainState = {
  chainId: '',
  windowKey: '',
  phase: 'idle',
  owner: null,
  ownerSeenAt: 0,
  requestedAt: null,
  fromStepId: null,
  toStepId: null,
  pausedUntil: 0,
  sevenDayAck: null,
  notifiedAll: null,
  notifiedSevenDay: null,
  forced: false,
}

export type ChainInput = {
  now: number
  sessionId: string
  stepId: string
  chain: Chain
  state: ChainState
  readings: Record<string, MeterReading>
  turnIdle: boolean
  handoffMtimeMs: number | null
  leaseMs?: number
}

export type ChainResult = {
  state: ChainState
  requestHandoff: { from: string; to: string } | null
  launch: { stepId: string } | null
  blocked: { kind: 'seven_day'; detail: string } | null
  notify: string | null
}

function quiet(state: ChainState): ChainResult {
  return { state, requestHandoff: null, launch: null, blocked: null, notify: null }
}

export function evaluateChain(input: ChainInput): ChainResult {
  const { chain, readings, now, sessionId, stepId } = input
  const leaseMs = input.leaseMs ?? 180_000
  const idx = chain.steps.findIndex(s => s.id === stepId)

  let state: ChainState =
    input.state.chainId === chain.id
      ? { ...input.state }
      : { ...initialChainState, chainId: chain.id }

  if (idx < 0) return quiet(state)
  const current = readings[stepId]
  if (!current) return quiet(state)

  if (
    state.phase === 'handoff_pending' &&
    state.owner !== null &&
    state.owner !== sessionId &&
    now - state.ownerSeenAt > leaseMs
  ) {
    state.owner = sessionId
    state.ownerSeenAt = now
  }
  if (state.owner === sessionId) state.ownerSeenAt = now
  if (current.fiveHourKey) state.windowKey = current.fiveHourKey

  // The session that left is inert until the chain moves again from the new side.
  if (state.phase === 'switched' && state.fromStepId === stepId) return quiet(state)

  // A failed read never moves anything.
  if (current.stale) return quiet(state)

  // A gate blocks this session's tools and never moves the chain, until the
  // person acknowledges that weekly window with /relay resume.
  if (isGateActive(state, current) && current.gate) {
    const key = current.sevenDayKey
    const notify = state.notifiedSevenDay === key ? null : current.gate.detail
    return {
      state: { ...state, notifiedSevenDay: key },
      requestHandoff: null,
      launch: null,
      blocked: { kind: 'seven_day', detail: current.gate.detail },
      notify,
    }
  }

  if (state.pausedUntil > now) return quiet(state)

  // A forced move (from /relay next or /relay back) is not cancelled or
  // retargeted by the automatic rules.
  if (state.forced && state.phase === 'handoff_pending' && state.owner === sessionId) {
    const freshForced =
      input.handoffMtimeMs !== null &&
      state.requestedAt !== null &&
      input.handoffMtimeMs >= state.requestedAt
    if (freshForced && input.turnIdle && state.toStepId) {
      return {
        state: { ...state, phase: 'switched', forced: false },
        requestHandoff: null,
        launch: { stepId: state.toStepId },
        blocked: null,
        notify: `Moving from ${stepId} to ${state.toStepId}.`,
      }
    }
    return quiet(state)
  }

  // Preference wins: the earliest earlier step that is available and fresh.
  let target: string | null = null
  let movingBack = false
  for (let i = 0; i < idx; i++) {
    const reading = readings[chain.steps[i].id]
    if (reading && !reading.stale && reading.available) {
      target = chain.steps[i].id
      movingBack = true
      break
    }
  }

  // Sticky: a current step that is still usable is kept, and a pending move it
  // no longer needs is cancelled.
  if (!target && !current.exhausted) {
    if (state.phase === 'handoff_pending' && state.owner === sessionId) {
      return quiet({
        ...state,
        phase: 'idle',
        fromStepId: null,
        toStepId: null,
        requestedAt: null,
        forced: false,
      })
    }
    return quiet(state)
  }

  // Otherwise the earliest later step that is not exhausted and not stale.
  if (!target) {
    for (let i = idx + 1; i < chain.steps.length; i++) {
      const reading = readings[chain.steps[i].id]
      if (reading && !reading.stale && !reading.exhausted) {
        target = chain.steps[i].id
        break
      }
    }
  }

  if (!target) {
    const key = `${chain.id}:${current.sevenDayKey || current.summary}`
    if (state.notifiedAll === key) return quiet(state)
    const reasons = chain.steps
      .filter(s => s.id !== stepId)
      .map(s => {
        const r = readings[s.id]
        if (!r) return `${s.id}: not read`
        return r.stale ? `${s.id}: stale (${r.summary})` : `${s.id}: exhausted`
      })
      .join('; ')
    return {
      ...quiet({ ...state, notifiedAll: key }),
      notify: `No eligible step (${reasons || 'no other steps'}).`,
    }
  }

  const fresh =
    input.handoffMtimeMs !== null &&
    state.requestedAt !== null &&
    input.handoffMtimeMs >= state.requestedAt

  if (state.phase === 'handoff_pending' && state.owner === sessionId) {
    if (state.toStepId !== target) {
      state.toStepId = target
      state.requestedAt = now
    }
    if (fresh && input.turnIdle) {
      return {
        state: { ...state, phase: 'switched' },
        requestHandoff: null,
        launch: { stepId: target },
        blocked: null,
        notify: `Moving from ${stepId} to ${target}.`,
      }
    }
    return quiet(state)
  }

  if (state.phase === 'handoff_pending' && state.owner !== null) return quiet(state)

  const claimed: ChainState = {
    ...state,
    phase: 'handoff_pending',
    owner: sessionId,
    ownerSeenAt: now,
    requestedAt: now,
    fromStepId: stepId,
    toStepId: target,
    notifiedAll: null,
  }
  return {
    state: claimed,
    requestHandoff: { from: stepId, to: target },
    launch: null,
    blocked: null,
    notify: movingBack ? `Returning to ${target}.` : null,
  }
}

export function acknowledgeSevenDay(state: ChainState, key: string): ChainState {
  return { ...state, sevenDayAck: key }
}

export function moveTo(
  state: ChainState,
  from: string,
  to: string,
  now: number,
  sessionId: string,
): ChainState {
  return {
    ...state,
    phase: 'handoff_pending',
    owner: sessionId,
    ownerSeenAt: now,
    requestedAt: now,
    fromStepId: from,
    toStepId: to,
    forced: true,
  }
}

export function isGateActive(state: ChainState, reading: MeterReading): boolean {
  if (!reading.gate) return false
  if (state.sevenDayAck && sameWindow(state.sevenDayAck, reading.sevenDayKey, 60_000)) return false
  return true
}

export function lockKeyFor(state: ChainState): string {
  return `${state.chainId}-${state.fromStepId ?? 'none'}-${state.toStepId ?? 'none'}-${state.windowKey || 'now'}`
    .replace(/[^a-z0-9-]/gi, '-')
}

export function isStaleLock(mtimeMs: number | null, now: number, leaseMs: number): boolean {
  return mtimeMs !== null && now - mtimeMs > leaseMs
}
