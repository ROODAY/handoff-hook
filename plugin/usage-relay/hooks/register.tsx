import type { PluginOptions, Register } from 'claude-code'
import { readConfig, type Config, type Role } from './lib/config'
import { fakeSnapshot, parseUsageResponse, readToken, fiveHourKey, sevenDayKey, type Snapshot } from './lib/usage'
import { acknowledgeSevenDay, evaluate, initialRelayState, type RelayState } from './lib/state'
import { gateTool } from './lib/gate'
import { buildLaunchArgv } from './lib/launch'
import {
  handoffReason,
  handoffRequestToClaude,
  sevenDayReason,
} from './lib/reason'

const TITLE = 'usage-relay'

function isRelayState(value: unknown): value is RelayState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.phase === 'string' && typeof v.windowKey === 'string'
}

function percent(value: number | null): string {
  return value === null ? '?' : String(Math.round(value))
}

function clockTime(ms: number | null): string {
  if (ms === null) return '?'
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const register: Register = (on, options: PluginOptions) => {
  let config: Config | null = null
  let sessionId = ''
  let root = ''
  let relay: RelayState | null = null
  let snapshot: Snapshot | null = null
  let handoffMtime: number | null = null
  let turnIdle = true
  let fakeFiveHour: number | null = null
  let tick: (() => Promise<void>) | null = null

  const role = (): Role => config?.role ?? 'none'

  on('session.start', async ($, e, next) => {
    const envRole = await $.env.get('USAGE_RELAY_ROLE')
    let model = ''
    try {
      model = (await $.session.model()) ?? ''
    } catch {
      model = ''
    }
    const inferredRole = envRole ?? (model.toLowerCase().includes('deepseek') ? 'deepseek' : undefined)
    config = readConfig(options, {
      USAGE_RELAY_ROLE: inferredRole,
      USAGE_RELAY_5H: await $.env.get('USAGE_RELAY_5H'),
      USAGE_RELAY_7D: await $.env.get('USAGE_RELAY_7D'),
      USAGE_RELAY_POLL: await $.env.get('USAGE_RELAY_POLL'),
      USAGE_RELAY_RESUME_BELOW: await $.env.get('USAGE_RELAY_RESUME_BELOW'),
      USAGE_RELAY_HANDOFF: await $.env.get('USAGE_RELAY_HANDOFF'),
      USAGE_RELAY_CLAUDE_MODEL: await $.env.get('USAGE_RELAY_CLAUDE_MODEL'),
      USAGE_RELAY_DEEPSEEK_MODEL: await $.env.get('USAGE_RELAY_DEEPSEEK_MODEL'),
      USAGE_RELAY_DISABLED: await $.env.get('USAGE_RELAY_DISABLED'),
      USAGE_RELAY_FAKE_5H: await $.env.get('USAGE_RELAY_FAKE_5H'),
      USAGE_RELAY_FAKE_7D: await $.env.get('USAGE_RELAY_FAKE_7D'),
      USAGE_RELAY_RESET: await $.env.get('USAGE_RELAY_RESET'),
    })
    sessionId = await $.session.id()
    root = await $.session.root()
    if ((await $.env.get('USAGE_RELAY_RESET')) === '1') {
      await $.store.delete('relay')
      await $.store.delete('usage')
    }
    const stored = await $.store.get('relay')
    relay = isRelayState(stored) ? stored : { ...initialRelayState }

    await $.command.register({
      name: 'relay',
      description: 'Usage relay: status, switch now, switch back, pause, resume, fake usage.',
      argumentHint: 'status|now|back|pause|resume|reset|test on|off',
    })

    let ticking = false
    tick = async () => {
      if (!config || ticking) return
      ticking = true
      try {
      const now = Date.now()
      const storedNow = await $.store.get('relay')
      if (isRelayState(storedNow)) relay = storedNow
      let fresh = fakeSnapshot(
        { fakeFiveHour: fakeFiveHour ?? config.fakeFiveHour, fakeSevenDay: config.fakeSevenDay },
        now,
      )
      if (!fresh) {
        try {
          const home = (await $.env.get('USERPROFILE')) ?? ''
          const token = readToken(await $.fs.read(`${home}/.claude/.credentials.json`), Date.now())
          if (token) {
            const res = await $.http.fetch('https://api.anthropic.com/api/oauth/usage', {
              headers: {
                Authorization: `Bearer ${token}`,
                'anthropic-beta': 'oauth-2025-04-20',
                'Content-Type': 'application/json',
              },
            })
            if (res.ok) fresh = parseUsageResponse(res.text, Date.now())
          }
        } catch {
          fresh = null
        }
      }
      if (!fresh) {
        snapshot = snapshot ? { ...snapshot, stale: true } : null
        $.ui.status('usage stale · could not read the Claude usage endpoint')
        return
      }
      snapshot = { ...fresh, stale: false }
      await $.store.set('usage', snapshot)
      $.ui.status(
        `5h ${percent(snapshot.fiveHour)}% · 7d ${percent(snapshot.sevenDay)}% · reset ${clockTime(snapshot.fiveHourResetsAt)}`,
      )

      // A session with no role shows usage but never claims, switches or writes relay state.
      if (config.role === 'none') return

      root = await $.session.root()
      try {
        const st = await $.fs.stat(`${root}/${config.handoffFile}`)
        handoffMtime = st.kind === 'file' ? st.mtimeMs : null
      } catch {
        handoffMtime = null
      }

      const result = evaluate({
        now,
        sessionId,
        role: config.role,
        config,
        snapshot,
        state: relay ?? initialRelayState,
        handoffMtimeMs: handoffMtime,
        turnIdle,
      })
      relay = result.state
      let locked = true
      if (result.requestHandoff) {
        const key = (result.requestHandoff.direction === 'to_deepseek'
          ? relay.windowKey
          : relay.returnFor ?? relay.windowKey).replace(/[^a-z0-9]/gi, '-')
        const lockName = `usage-relay-${result.requestHandoff.direction}-${key}.lock`
        try {
          const claimed = await $.process.run(
            ['pwsh', '-NoProfile', '-NonInteractive', '-Command',
              `try { $f=[IO.File]::CreateNew([IO.Path]::Combine([IO.Path]::GetTempPath(),'${lockName}')); $f.Dispose(); exit 0 } catch { exit 1 }`],
            { timeoutMs: 5_000 },
          )
          locked = ((claimed as { exitCode?: number } | undefined)?.exitCode ?? 0) === 0
        } catch {
          // No process runner (a test host, a locked-down shell): the store claim still gates.
          locked = true
        }
        if (!locked) {
          const shared = await $.store.get('relay')
          if (isRelayState(shared)) relay = shared
          return
        }
      }
      await $.store.set('relay', relay)

      if (result.requestHandoff) {
        const text =
          result.requestHandoff.direction === 'to_deepseek' && snapshot.fiveHour !== null
            ? handoffReason(snapshot.fiveHour, config.handoffFile)
            : handoffRequestToClaude(config.handoffFile)
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
        if (result.requestHandoff.direction === 'to_claude' && turnIdle) {
          await $.prompt.submit({
            text: `Claude's 5-hour window has reset. Write ${config.handoffFile} in the project root using the template above, then end your turn.`,
          })
        }
      }

      if (result.notify) {
        void $.ui.notify(result.notify, { title: TITLE })
      }

      if (result.launch) {
        const current = await $.store.get('relay')
        if (
          isRelayState(current) &&
          current.owner === sessionId &&
          current.phase === relay.phase
        ) {
          let terminal = config.terminal
          if (terminal.toLowerCase() === 'preview') {
            try {
              const found = await $.process.run(
                ['pwsh', '-NoProfile', '-NonInteractive', '-Command',
                  '(Get-AppxPackage Microsoft.WindowsTerminalPreview).InstallLocation'],
                { timeoutMs: 5_000 },
              )
              const loc = (found.stdout ?? '').trim()
              if (loc) terminal = `${loc}\WindowsTerminal.exe`
            } catch {
              terminal = 'wt'
            }
          }
          try {
            await $.process.run(
              buildLaunchArgv({ root, target: result.launch.target, config: { ...config, terminal } }),
              { timeoutMs: 10_000 },
            )
          } catch {
            void $.ui.notify(
              `Could not open a terminal tab. Run this yourself: claude --model "${result.launch.target === 'deepseek' ? config.deepseekModel : config.claudeModel}"`,
              { title: TITLE },
            )
          }
        }
      }

      if (result.blocked?.kind === 'seven_day' && snapshot.sevenDay !== null) {
        $.ui.status(sevenDayReason(snapshot.sevenDay))
      }
      } catch {
        // a failed tick leaves the last known state in place
      } finally {
        ticking = false
      }
    }

    await tick()
    if (config.role !== 'none') {
      $.clock.every(config.pollSeconds * 1000, () => {
        void tick?.().catch(() => {})
      })
    }
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (!config || !config.enabled || config.role !== 'claude') return next(e)
    const state = relay ?? initialRelayState
    const pending = state.phase === 'handoff_pending' && state.owner === sessionId
    const weekly = !pending && snapshot !== null && !snapshot.stale &&
      snapshot.sevenDay !== null && snapshot.sevenDay >= config.sevenDayThreshold &&
      sevenDayKey(snapshot) !== (state.sevenDayAck ?? '')
    if (!pending && !weekly) return next(e)
    const denial = gateTool(
      { kind: pending ? 'handoff' : 'seven_day', root, handoffFile: config.handoffFile,
        percent: pending ? snapshot?.fiveHour ?? null : snapshot?.sevenDay ?? null },
      String(e.tool),
      e as unknown as Record<string, unknown>,
    )
    return denial ?? next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'usage-relay: its guard failed.' }))

  on('classic.Stop', async ($, e, next) => {
    if (!config || !config.enabled || !snapshot || !relay) return next(e)
    if (e.stop_hook_active || config.role !== 'claude') return next(e)
    const pending =
      relay.phase === 'handoff_pending' &&
      relay.owner === sessionId &&
      snapshot.fiveHour !== null &&
      snapshot.fiveHour >= config.fiveHourThreshold
    let written = handoffMtime !== null && relay.requestedAt !== null && handoffMtime >= relay.requestedAt
    if (!written) {
      try {
        const st = await $.fs.stat(`${root}/${config.handoffFile}`)
        written = st.kind === 'file' && relay.requestedAt !== null && st.mtimeMs >= relay.requestedAt
      } catch {
        written = false
      }
    }
    if (!pending || written) return next(e)
    return { block: handoffReason(snapshot.fiveHour ?? 0, config.handoffFile) }
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    return e.stop_hook_active
      ? undefined
      : { block: 'usage-relay: its guard failed. Write the handoff before ending the turn.' }
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId) return next(e)
    turnIdle = false
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    turnIdle = true
    if (e.reason === 'answer') await tick?.()
    return next(e)
  })

  on('command.run', { command: 'relay' }, async ($, e, next) => {
    if (!config) return next(e)
    const arg = e.args.trim().toLowerCase()
    const now = Date.now()
    const state = relay ?? initialRelayState

    if (arg === 'now' && snapshot) {
      relay = {
        ...state,
        phase: 'handoff_pending',
        owner: sessionId,
        ownerSeenAt: now,
        requestedAt: now,
        windowKey: fiveHourKey(snapshot),
        switchedAt: null,
      }
      await $.store.set('relay', relay)
      return { text: `Switching at the end of this turn. Handoff: ${config.handoffFile}.` }
    }
    if (arg === 'back' && snapshot) {
      relay = {
        ...state,
        phase: 'return_pending',
        owner: sessionId,
        ownerSeenAt: now,
        requestedAt: now,
        returnFor: fiveHourKey(snapshot),
      }
      await $.store.set('relay', relay)
      return { text: `Returning to Claude at the end of this turn. Handoff: ${config.handoffFile}.` }
    }
    if (arg === 'pause') {
      relay = { ...state, pausedUntil: now + 5 * 3_600_000 }
      await $.store.set('relay', relay)
      return { text: 'Switches paused for five hours (or until /relay resume).' }
    }
    if (arg === 'resume') {
      const acked = snapshot ? acknowledgeSevenDay(config, snapshot, state) : state
      relay = { ...acked, pausedUntil: 0 }
      await $.store.set('relay', relay)
      return { text: 'Weekly usage acknowledged for this window; tools unblocked.' }
    }
    if (arg === 'reset') {
      relay = { ...initialRelayState }
      await $.store.set('relay', relay)
      await $.store.delete('usage')
      return { text: 'Relay state cleared for this machine.' }
    }
    if (arg === 'test on') {
      fakeFiveHour = 95
      await tick?.()
      return { text: 'Fake usage on: the 5-hour window reads 95%.' }
    }
    if (arg === 'test off') {
      fakeFiveHour = null
      await tick?.()
      return { text: 'Fake usage off.' }
    }
    if (arg === 'status' || arg === '') {
      const lines = [
        `role: ${role()} · phase: ${state.phase} · owner: ${state.owner ?? 'none'}`,
        snapshot
          ? `5h ${percent(snapshot.fiveHour)}% (reset ${clockTime(snapshot.fiveHourResetsAt)}) · 7d ${percent(snapshot.sevenDay)}% (reset ${clockTime(snapshot.sevenDayResetsAt)})`
          : 'usage: not read yet',
        `thresholds: switch ${config.fiveHourThreshold}% · return below ${config.resumeBelow}% · 7d pause ${config.sevenDayThreshold}%`,
      ]
      return { text: lines.join('\n') }
    }
    return { text: 'Usage: /relay status | now | back | pause | resume | test on | test off' }
  })
}
