import type { PluginOptions, Register } from 'claude-code'
import { readConfig, type Config } from './lib/config'
import { matchStepByModel, parseChain, type Chain, type ChainStep } from './lib/chain'
import {
  evaluateChain,
  initialChainState,
  isGateActive,
  isStaleLock,
  lockKeyFor,
  moveTo,
  type ChainState,
} from './lib/chainstate'
import { readMeter, type MeterReading } from './lib/meters'
import { nextUsage, readToken, sevenDayKey, type Snapshot } from './lib/usage'
import { gateTool } from './lib/gate'
import { buildLaunchArgv } from './lib/launch'
import { handoffReminder, moveReason } from './lib/reason'

const TITLE = 'usage-relay'
const LEASE_MS = 180_000

function isChainState(value: unknown): value is ChainState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.phase === 'string' && typeof v.chainId === 'string'
}

export const register: Register = (on, options: PluginOptions) => {
  let config: Config | null = null
  let chain: Chain | null = null
  let chainError = 'no chain configured'
  let stepId: string | null = null
  let enabled = false
  let sessionId = ''
  let root = ''
  let home = ''
  let relay: ChainState | null = null
  let readings: Record<string, MeterReading> = {}
  let usage: Snapshot | null = null
  let handoffMtime: number | null = null
  let turnIdle = true
  let ticking = false
  let tick: (() => Promise<void>) | null = null

  const currentStep = (): ChainStep | null =>
    chain && stepId ? chain.steps.find(s => s.id === stepId) ?? null : null

  const statusText = (): string => {
    if (!config) return 'usage-relay: starting'
    if (!enabled) return 'usage-relay: disabled'
    if (!chain) return `usage-relay: ${chainError}`
    if (!stepId) return 'usage-relay: this model is not a step in the chain'
    const index = chain.steps.findIndex(s => s.id === stepId)
    if (index < 0) return 'usage-relay: this model is not a step in the chain'
    const step = chain.steps[index]
    const reading = readings[stepId]
    const next = chain.steps[index + 1]?.label ?? 'none'
    return `[${index + 1}/${chain.steps.length}] ${step.label} · ${reading?.summary ?? 'no reading'} · next ${next}`
  }

  on('session.start', async ($, e, next) => {
    config = readConfig(options, {
      USAGE_RELAY_STEP: await $.env.get('USAGE_RELAY_STEP'),
      USAGE_RELAY_CHAIN_FILE: await $.env.get('USAGE_RELAY_CHAIN_FILE'),
      USAGE_RELAY_ENABLED: await $.env.get('USAGE_RELAY_ENABLED'),
      USAGE_RELAY_FAKE_METERS: await $.env.get('USAGE_RELAY_FAKE_METERS'),
      USAGE_RELAY_HANDOFF: await $.env.get('USAGE_RELAY_HANDOFF'),
      USAGE_RELAY_POLL: await $.env.get('USAGE_RELAY_POLL'),
      USAGE_RELAY_TERMINAL: await $.env.get('USAGE_RELAY_TERMINAL'),
      USAGE_RELAY_DISABLED: await $.env.get('USAGE_RELAY_DISABLED'),
      USAGE_RELAY_RESET: await $.env.get('USAGE_RELAY_RESET'),
      USERPROFILE: await $.env.get('USERPROFILE'),
      DEEPSEEK_API_KEY: await $.env.get('DEEPSEEK_API_KEY'),
    })
    sessionId = await $.session.id()
    root = await $.session.root()
    home = (await $.env.get('USERPROFILE')) ?? ''
    enabled = config.enabled

    if (config.reset) {
      await $.store.delete('relay')
      await $.store.delete('meters')
      await $.store.delete('usage')
    }

    const loadChain = async (): Promise<void> => {
      if (!config) return
      try {
        const text = await $.fs.read(config.chainFile)
        if (typeof text !== 'string') {
          chain = null
          chainError = 'no chain configured'
          return
        }
        const parsed = parseChain(text)
        if ('error' in parsed) {
          chain = null
          chainError = parsed.error
          return
        }
        chain = parsed.chain
        chainError = ''
      } catch {
        chain = null
        chainError = 'no chain configured'
      }
    }
    await loadChain()

    if (!stepId) {
      let model = ''
      try {
        model = (await $.session.model()) ?? ''
      } catch {
        model = ''
      }
      stepId = (await $.env.get('USAGE_RELAY_STEP')) ??
        (chain && model ? matchStepByModel(chain, model)?.id ?? null : null)
    }

    const stored = await $.store.get('relay')
    relay = isChainState(stored) ? stored : { ...initialChainState }

    await $.command.register({
      name: 'relay',
      description: 'Chain relay: enable, disable, status, next, back, reload, pause, resume, reset, meters, test.',
      argumentHint: 'enable|disable|status|next|back|reload|pause|resume|reset|meters|test on|off',
    })

    tick = async () => {
      if (!config || ticking) return
      ticking = true
      try {
        if (!enabled) {
          $.ui.status('usage-relay: disabled')
          return
        }
        if (!chain || !stepId) {
          $.ui.status(statusText())
          return
        }
        const now = Date.now()

        // Re-read the shared state every tick: another session may own the move.
        const sharedNow = await $.store.get('relay')
        if (isChainState(sharedNow)) relay = sharedNow

        if (chain.steps.some(s => s.meter.type === 'claude-oauth')) {
          let text: string | null = null
          try {
            const token = readToken(await $.fs.read(`${home}/.claude/.credentials.json`), Date.now())
            if (token) {
              const res = await $.http.fetch('https://api.anthropic.com/api/oauth/usage', {
                headers: {
                  Authorization: `Bearer ${token}`,
                  'anthropic-beta': 'oauth-2025-04-20',
                  'Content-Type': 'application/json',
                },
              })
              if (res.ok) text = res.text
            }
          } catch {
            text = null
          }
          usage = nextUsage(usage, text, now)
        }

        const balances: Record<string, unknown> = {}
        for (const step of chain.steps) {
          if (step.meter.type !== 'deepseek-balance' || !config.deepseekApiKey) continue
          try {
            const res = await $.http.fetch('https://api.deepseek.com/user/balance', {
              headers: { Authorization: `Bearer ${config.deepseekApiKey}` },
            })
            if (res.ok) balances[String(step.meter.api_key_env)] = JSON.parse(res.text)
          } catch {
            // the reading reports itself stale
          }
        }

        let spendUsd: number | null = null
        try {
          const live = await $.session.usage()
          spendUsd = typeof live.cost?.usd === 'number' ? live.cost.usd : null
        } catch {
          spendUsd = null
        }

        readings = {}
        for (const step of chain.steps) {
          const base = readMeter(
            step,
            { usage, balances, spendUsd, isCurrent: step.id === stepId },
            now,
          )
          const fake = config.fakeMeters?.[step.id]
          readings[step.id] = fake
            ? {
                ...base,
                exhausted: fake.exhausted ?? base.exhausted,
                available: fake.available ?? base.available,
                stale: false,
                summary: `${base.summary} (fake)`,
              }
            : base
        }
        await $.store.set('meters', readings)
        if (usage) await $.store.set('usage', usage)

        try {
          const st = await $.fs.stat(`${root}/${config.handoffFile}`)
          handoffMtime = st.kind === 'file' ? st.mtimeMs : null
        } catch {
          handoffMtime = null
        }

        const result = evaluateChain({
          now,
          sessionId,
          stepId,
          chain,
          state: relay ?? initialChainState,
          readings,
          turnIdle,
          handoffMtimeMs: handoffMtime,
        })
        relay = result.state
        if (relay.owner === sessionId || relay.owner === null) {
          await $.store.set('relay', relay)
        }
        $.ui.status(statusText())

        if (result.requestHandoff) {
          const from = chain.steps.find(s => s.id === result.requestHandoff?.from)
          const to = chain.steps.find(s => s.id === result.requestHandoff?.to)
          const text = moveReason(
            from?.label ?? 'this step',
            to?.label ?? 'the next step',
            config.handoffFile,
          )
          await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
          const fromIndex = chain.steps.findIndex(s => s.id === result.requestHandoff?.from)
          const toIndex = chain.steps.findIndex(s => s.id === result.requestHandoff?.to)
          if (turnIdle && toIndex >= 0 && fromIndex >= 0 && toIndex < fromIndex) {
            await $.prompt.submit({ text })
          }
        }

        if (result.blocked) {
          $.ui.status(result.blocked.detail)
          void $.ui.notify(result.blocked.detail, { title: TITLE })
        }
        if (result.notify) void $.ui.notify(result.notify, { title: TITLE })

        if (result.launch) {
          const target = chain.steps.find(s => s.id === result.launch?.stepId)
          if (!target) return
          const sharedCheck = await $.store.get('relay')
          if (
            !isChainState(sharedCheck) ||
            sharedCheck.owner !== sessionId ||
            sharedCheck.phase !== relay.phase
          ) {
            $.ui.status(`${statusText()} · another session is moving the chain`)
            return
          }
          const lockPath = `${home}\\.claude\\usage-relay\\lock-${lockKeyFor(relay)}.lock`
          let existing = false
          let mtime: number | null = null
          try {
            const st = await $.fs.stat(lockPath)
            existing = st.kind === 'file'
            mtime = typeof st.mtimeMs === 'number' ? st.mtimeMs : null
          } catch {
            existing = false
          }
          if (existing && !isStaleLock(mtime, Date.now(), LEASE_MS)) {
            $.ui.status(`${statusText()} · another session is moving the chain`)
            return
          }
          const dir = `${home}\\.claude\\usage-relay`
          const remove = existing ? `if (Test-Path '${lockPath}') { Remove-Item -Force '${lockPath}' }; ` : ''
          const script =
            `[IO.Directory]::CreateDirectory('${dir}') | Out-Null; ${remove}` +
            `try { $f=[IO.File]::Open('${lockPath}',[IO.FileMode]::CreateNew); $f.Dispose(); exit 0 } catch { exit 1 }`
          let acquired = true
          try {
            const claimed = await $.process.run(
              ['pwsh', '-NoProfile', '-NonInteractive', '-Command', script],
              { timeoutMs: 5_000 },
            )
            acquired = ((claimed as { exitCode?: number } | undefined)?.exitCode ?? 0) === 0
          } catch {
            // Fail closed: without the lock, do not launch a second successor.
            acquired = false
          }
          if (!acquired) {
            $.ui.status(`${statusText()} · another session is moving the chain`)
            return
          }

          let terminal = config.terminal
          if (terminal.toLowerCase() === 'preview') {
            try {
              const found = await $.process.run(
                ['pwsh', '-NoProfile', '-NonInteractive', '-Command',
                  '(Get-AppxPackage Microsoft.WindowsTerminalPreview).InstallLocation'],
                { timeoutMs: 5_000 },
              )
              const loc = (found.stdout ?? '').trim()
              if (loc) terminal = `${loc}\\WindowsTerminal.exe`
            } catch {
              terminal = 'wt'
            }
          }
          try {
            await $.process.run(
              buildLaunchArgv({
                root,
                step: target,
                chainFile: config.chainFile,
                config: { ...config, terminal },
              }),
              { timeoutMs: 10_000 },
            )
            relay = { ...relay, phase: 'switched' }
            await $.store.set('relay', relay)
          } catch {
            relay = { ...relay, phase: 'idle', fromStepId: null, toStepId: null, requestedAt: null }
            await $.store.set('relay', relay)
            try {
              await $.process.run(
                ['pwsh', '-NoProfile', '-NonInteractive', '-Command', `Remove-Item -Force '${lockPath}'`],
                { timeoutMs: 5_000 },
              )
            } catch {
              // best effort
            }
            void $.ui.notify(
              `Could not open a terminal tab for ${target.label}. Run: claude --model "${target.model}"`,
              { title: TITLE },
            )
          }
        }
      } catch {
        // a failed tick leaves the last known state in place
      } finally {
        ticking = false
      }
    }

    await tick()
    // Poll unconditionally: a session enabled later starts polling from here.
    $.clock.every(config.pollSeconds * 1000, () => {
      void tick?.().catch(() => {})
    })
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (!config || !enabled || !chain || !stepId) return next(e)
    const state = relay ?? initialChainState
    const reading = readings[stepId]
    const pending = state.phase === 'handoff_pending' && state.owner === sessionId
    const gated = Boolean(reading && !reading.stale && reading.gate && isGateActive(state, reading))
    if (!pending && !gated) return next(e)
    const deny = gateTool(
      { kind: pending ? 'handoff' : 'seven_day', root, handoffFile: config.handoffFile },
      String(e.tool),
      e as unknown as Record<string, unknown>,
    )
    if (!deny) return next(e)
    return gated && !pending ? { deny: reading.gate?.detail ?? deny.deny } : deny
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'usage-relay: its guard failed.' }))

  on('classic.Stop', async ($, e, next) => {
    if (!config || !enabled || !relay || !stepId) return next(e)
    if (e.stop_hook_active) return next(e)
    const pending = relay.phase === 'handoff_pending' && relay.owner === sessionId
    if (!pending || relay.requestedAt === null) return next(e)
    let written = handoffMtime !== null && handoffMtime >= relay.requestedAt
    if (!written) {
      try {
        const st = await $.fs.stat(`${root}/${config.handoffFile}`)
        written = st.kind === 'file' && st.mtimeMs >= relay.requestedAt
      } catch {
        written = false
      }
    }
    if (written) return next(e)
    return { block: handoffReminder(config.handoffFile) }
  }).catch(($, e, next) => (next.called ? next(e) : undefined))

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
    const sharedCmd = await $.store.get('relay')
    if (isChainState(sharedCmd)) relay = sharedCmd
    const arg = e.args.trim().toLowerCase()
    const step = currentStep()

    if (arg === 'enable') {
      if (!chain) {
        try {
          const text = await $.fs.read(config.chainFile)
          const parsed = typeof text === 'string' ? parseChain(text) : null
          if (parsed && 'chain' in parsed) {
            chain = parsed.chain
            chainError = ''
          }
        } catch {
          chain = null
        }
      }
      if (!chain) {
        return { text: `No chain configured. Set chain_file in /config or create ${config.chainFile}.` }
      }
      if (!stepId) {
        let model = ''
        try {
          model = (await $.session.model()) ?? ''
        } catch {
          model = ''
        }
        stepId = matchStepByModel(chain, model)?.id ?? null
      }
      if (!stepId) {
        return {
          text: 'This model is not a step in the chain; set USAGE_RELAY_STEP or add the model to the chain.',
        }
      }
      enabled = true
      await tick?.()
      return { text: `Relay enabled on step ${stepId}.` }
    }
    if (arg === 'disable') {
      enabled = false
      $.ui.status('usage-relay: disabled')
      return { text: 'Relay disabled for this session.' }
    }
    if (arg === 'reload') {
      try {
        const text = await $.fs.read(config.chainFile)
        const parsed = typeof text === 'string' ? parseChain(text) : null
        if (parsed && 'chain' in parsed) {
          chain = parsed.chain
          chainError = ''
          await tick?.()
          return { text: `Chain reloaded: ${chain.steps.map(s => s.label).join(' -> ')}` }
        }
        if (parsed && 'error' in parsed) return { text: parsed.error }
        return { text: `No chain configured at ${config.chainFile}.` }
      } catch {
        return { text: `No chain configured at ${config.chainFile}.` }
      }
    }
    if (arg === 'next' || arg === 'back') {
      if (!enabled) return { text: 'Run /relay enable first.' }
      if (!chain || !stepId) return { text: 'No chain or step; run /relay reload.' }
      const index = chain.steps.findIndex(s => s.id === stepId)
      const target =
        arg === 'next'
          ? chain.steps[index + 1]
          : [...chain.steps.slice(0, index)]
              .reverse()
              .find(s => readings[s.id]?.available && !readings[s.id]?.stale)
      if (!target) {
        return { text: arg === 'next' ? 'This is the last step.' : 'No earlier step is available.' }
      }
      relay = moveTo(relay ?? initialChainState, stepId, target.id, Date.now(), sessionId)
      await $.store.set('relay', relay)
      return { text: `Moving to ${target.label} at the end of this turn.` }
    }
    if (arg === 'pause') {
      relay = { ...(relay ?? initialChainState), pausedUntil: Date.now() + 5 * 3_600_000 }
      await $.store.set('relay', relay)
      return { text: 'Chain moves paused for five hours.' }
    }
    if (arg === 'resume') {
      const key = readings[stepId ?? '']?.sevenDayKey || (usage ? sevenDayKey(usage) : '')
      relay = { ...(relay ?? initialChainState), pausedUntil: 0, sevenDayAck: key }
      await $.store.set('relay', relay)
      return { text: 'Weekly usage acknowledged; tools unblocked.' }
    }
    if (arg === 'reset') {
      relay = { ...initialChainState }
      readings = {}
      await $.store.delete('relay')
      await $.store.delete('meters')
      await $.store.delete('usage')
      return { text: 'Relay state cleared for this machine.' }
    }
    if (arg === 'meters') {
      if (!chain) return { text: 'No chain configured.' }
      return {
        text: chain.steps
          .map(s => {
            const r = readings[s.id]
            if (!r) return `${s.id}: not read yet`
            const bits = [`${s.id}: ${r.summary}`, `exhausted=${r.exhausted}`, `available=${r.available}`]
            if (r.stale) bits.push('stale')
            if (r.gate) bits.push('gated')
            return bits.join(' · ')
          })
          .join('\n'),
      }
    }
    if (arg === 'test on' || arg === 'test off') {
      const fake: Record<string, { exhausted?: boolean; available?: boolean }> = {
        ...(config.fakeMeters ?? {}),
      }
      if (arg === 'test on' && stepId) fake[stepId] = { exhausted: true, available: false }
      if (arg === 'test off' && stepId) delete fake[stepId]
      config = { ...config, fakeMeters: Object.keys(fake).length ? fake : null }
      await tick?.()
      return { text: arg === 'test on' ? 'Fake usage on for this step.' : 'Fake usage off.' }
    }
    if (arg === 'status' || arg === '') {
      return {
        text: [
          `relay: ${enabled ? 'enabled' : 'disabled'} · chain: ${chain ? chain.steps.map(s => s.id).join(' -> ') : chainError}`,
          `step: ${stepId ?? 'none'}${step ? ` (${step.model})` : ''} · phase: ${relay?.phase ?? 'idle'} · owner: ${relay?.owner ?? 'none'}`,
          usage
            ? `usage: 5h ${usage.fiveHour ?? '?'}% · 7d ${usage.sevenDay ?? '?'}%`
            : 'usage: not read',
        ].join('\n'),
      }
    }
    return {
      text: 'Usage: /relay enable | disable | status | next | back | reload | pause | resume | reset | meters | test on|off',
    }
  })
}
