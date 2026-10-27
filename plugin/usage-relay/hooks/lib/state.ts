import type { Config, Role } from './config'
import { fiveHourKey, sameWindow, sevenDayKey, type Snapshot } from './usage'

export type Phase = 'idle' | 'handoff_pending' | 'switched' | 'return_pending' | 'returned'

export type RelayState = {
  windowKey: string
  phase: Phase
  owner: string | null
  ownerSeenAt: number
  requestedAt: number | null
  switchedAt: number | null
  pausedUntil: number
  sevenDayAck: string | null
  returnFor: string | null
  notifiedSevenDay: string | null
}

export const initialRelayState: RelayState = {
  windowKey: '',
  phase: 'idle',
  owner: null,
  ownerSeenAt: 0,
  requestedAt: null,
  switchedAt: null,
  pausedUntil: 0,
  sevenDayAck: null,
  returnFor: null,
  notifiedSevenDay: null,
}

export type EvaluateInput = {
  now: number
  sessionId: string
  role: Role
  config: Config
  snapshot: Snapshot
  state: RelayState
  handoffMtimeMs: number | null
  turnIdle: boolean
  leaseMs?: number
}

export type EvaluateResult = {
  state: RelayState
  requestHandoff: { direction: 'to_deepseek' | 'to_claude' } | null
  launch: { target: 'deepseek' | 'claude' } | null
  blocked: { kind: 'handoff' | 'seven_day' } | null
  notify: string | null
}

const WINDOW_TOLERANCE_MS = 60_000

function quiet(state: RelayState): EvaluateResult {
  return { state, requestHandoff: null, launch: null, blocked: null, notify: null }
}

function handoffFresh(input: EvaluateInput): boolean {
  return (
    input.handoffMtimeMs !== null &&
    input.state.requestedAt !== null &&
    input.handoffMtimeMs >= input.state.requestedAt
  )
}

export function evaluate(input: EvaluateInput): EvaluateResult {
  const { config, snapshot, now, sessionId, role } = input
  const leaseMs = input.leaseMs ?? 180_000

  if (!config.enabled || role === 'none') {
    return quiet(input.state)
  }
  // A stale reading must not disarm a handoff already in flight.
  const inFlight = input.state.phase === 'handoff_pending' || input.state.phase === 'return_pending'
  if (snapshot.stale && !inFlight) {
    return quiet(input.state)
  }

  let state: RelayState = { ...input.state }
  const usesTolerance = (a: string, b: string) => sameWindow(a, b, WINDOW_TOLERANCE_MS)

  // A lease held by a session that stopped polling is taken over.
  if (
    state.phase === 'handoff_pending' &&
    state.owner !== null &&
    state.owner !== sessionId &&
    now - state.ownerSeenAt > leaseMs
  ) {
    state = { ...state, owner: sessionId, ownerSeenAt: now }
  }

  const currentKey = fiveHourKey(snapshot)
  const windowChanged = state.windowKey !== '' && !usesTolerance(state.windowKey, currentKey)
  if (windowChanged && (snapshot.fiveHour === null || snapshot.fiveHour < config.fiveHourThreshold)) {
    state = {
      ...initialRelayState,
      windowKey: currentKey,
      sevenDayAck: state.sevenDayAck,
      pausedUntil: state.pausedUntil,
      notifiedSevenDay: state.notifiedSevenDay,
    }
  }

  if (role === 'claude' && snapshot.sevenDay !== null &&
      snapshot.sevenDay >= config.sevenDayThreshold &&
      !usesTolerance(sevenDayKey(snapshot), state.sevenDayAck ?? '')) {
    const key = sevenDayKey(snapshot)
    const notify = state.notifiedSevenDay === key
      ? null
      : `Weekly usage is at ${Math.round(snapshot.sevenDay)}% of the 7-day cap. Tool calls are paused; run /relay resume to acknowledge this window.`
    const nextState = { ...state, ownerSeenAt: state.owner === sessionId ? now : state.ownerSeenAt, notifiedSevenDay: key }
    const result = quiet(nextState)
    result.blocked = { kind: 'seven_day' }
    result.notify = notify
    return suppressIfPaused(result, state.pausedUntil, now)
  }

  if (role === 'claude' && snapshot.fiveHour !== null && snapshot.fiveHour >= config.fiveHourThreshold) {
    const claimedByOther =
      state.phase === 'handoff_pending' && state.owner !== null && state.owner !== sessionId
    if (claimedByOther) {
      return quiet({ ...state, ownerSeenAt: state.ownerSeenAt })
    }

    let requestHandoff: EvaluateResult['requestHandoff'] = null
    const mayClaim = state.phase === 'idle' || state.phase === 'returned'
    if (mayClaim || !usesTolerance(state.windowKey, currentKey)) {
      state = {
        ...state,
        windowKey: currentKey,
        phase: 'handoff_pending',
        owner: sessionId,
        ownerSeenAt: now,
        requestedAt: now,
        switchedAt: null,
      }
      requestHandoff = { direction: 'to_deepseek' }
    } else if (state.owner === sessionId) {
      state = { ...state, ownerSeenAt: now }
    }

    if (state.phase === 'handoff_pending' && state.owner === sessionId) {
      if (handoffFresh(input)) {
        if (input.turnIdle) {
          const launched: EvaluateResult = {
            state: { ...state, phase: 'switched', switchedAt: now },
            requestHandoff: null,
            launch: { target: 'deepseek' },
            blocked: null,
            notify: `Claude at ${Math.round(snapshot.fiveHour)}% — DeepSeek session started.`,
          }
          return suppressIfPaused(launched, state.pausedUntil, now)
        }
        return suppressIfPaused(quiet(state), state.pausedUntil, now)
      }
      const result = quiet(state)
      result.blocked = { kind: 'handoff' }
      result.requestHandoff = requestHandoff
      return suppressIfPaused(result, state.pausedUntil, now)
    }

    return suppressIfPaused(quiet(state), state.pausedUntil, now)
  }

  if (role === 'deepseek') {
    const usable =
      snapshot.fiveHour !== null &&
      snapshot.fiveHour <= config.resumeBelow &&
      (state.returnFor === null || !usesTolerance(state.returnFor, currentKey))

    const returning = state.phase === 'return_pending' && state.owner === sessionId

    if (usable || returning) {
      let requestHandoff: EvaluateResult['requestHandoff'] = null
      if (!returning) {
        state = {
          ...state,
          windowKey: currentKey,
          phase: 'return_pending',
          owner: sessionId,
          ownerSeenAt: now,
          requestedAt: now,
          returnFor: currentKey,
        }
        requestHandoff = { direction: 'to_claude' }
      } else {
        state = { ...state, ownerSeenAt: now }
      }

      if (handoffFresh(input)) {
        if (input.turnIdle) {
          const launched: EvaluateResult = {
            state: { ...state, phase: 'returned' },
            requestHandoff,
            launch: { target: 'claude' },
            blocked: null,
            notify: 'Claude is available again — Claude session started.',
          }
          return suppressIfPaused(launched, state.pausedUntil, now)
        }
        return suppressIfPaused(quiet(state), state.pausedUntil, now)
      }
      const result = quiet(state)
      result.requestHandoff = requestHandoff
      return suppressIfPaused(result, state.pausedUntil, now)
    }
  }

  return suppressIfPaused(quiet(state), state.pausedUntil, now)
}

function suppressIfPaused(result: EvaluateResult, pausedUntil: number, now: number): EvaluateResult {
  if (pausedUntil <= now) return result
  return { ...result, requestHandoff: null, launch: null, notify: null }
}

export function acknowledgeSevenDay(
  _config: Config,
  snapshot: Snapshot,
  state: RelayState,
): RelayState {
  return { ...state, sevenDayAck: sevenDayKey(snapshot) }
}
