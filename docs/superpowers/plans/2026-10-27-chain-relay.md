# Chain Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the two-role usage relay into a configurable, preference-ordered chain of models that the mod rotates through when a step's own meter says it is exhausted, writing a handoff at every move.

**Architecture:** A `chain.json` file lists steps (model + meter). Pure modules parse and validate the chain, read meters from gathered inputs, and select the step to be on; `register.tsx` gathers inputs inline (the mod API forbids passing `$`), writes shared state, and launches the chosen step's model in a new tab with `USAGE_RELAY_STEP`.

**Tech Stack:** TypeScript hooks module (Claude Code mod API 2.1.312, early access), `claude plugin test`/`validate`, Windows Terminal, PowerShell 7.

**Spec:** `docs/superpowers/specs/2026-10-27-chain-relay-design.md`

## Global Constraints

- Windows only; no new dependencies; no build step. All new code under `plugin/usage-relay/`.
- Never read or edit CCR config, databases or logs. Provider keys come from the environment or `userConfig` secure storage only, and are never stored in `$.store`, printed, or logged.
- `$` is never passed to a helper function (validate refuses it); gathering is inline, decisions are pure.
- Keep the existing contracts: handoff template, reads-allowed gate, `classic.Stop` once, exclusive lock, three-minute lease, `wt`/`preview`/path terminal, `USAGE_RELAY_RESET`.
- Version 0.2.0. `userConfig` keeps `chain_file`, `handoff_file`, `terminal`, `poll_seconds`, `enabled`, and adds a sensitive `deepseek_api_key`; the old threshold fields are removed.
- Every guard hook registers `.catch` and fails closed.
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

1. A current step inside its hysteresis band (DeepSeek at $2.50 with leave-$2 / return-$3) is neither exhausted nor available → the chain must stay put, not skip it or report all exhausted. Test in Task 3.
2. A 7-day breach blocks tools and never moves the chain. Test in Tasks 2 and 3.
3. A failed meter read (missing key, bad JSON, endpoint error) produces a `stale` reading that never causes a move, and the status names the missing key. Tests in Tasks 2 and 5.
4. An invalid chain disables the chain wholesale: no moves, no gate, a status line that names the error. Test in Tasks 1 and 5.
5. One move per `(chainId, from, to, windowKey)`: a stale lock is reaped and a failed launch releases it. Test in Task 3 (selection/idempotence) and Task 5 (lock protocol).

---

### Task 1: Chain parsing, validation and model matching

**Files:**
- Create: `plugin/usage-relay/hooks/lib/chain.ts`
- Create: `plugin/usage-relay/hooks/lib/chain.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type MeterType = 'claude-oauth' | 'deepseek-balance' | 'session-spend'`
  - `type ChainStep = { id: string; label: string; model: string; meter: Record<string, unknown> & { type: MeterType } }`
  - `type Chain = { id: string; steps: ChainStep[] }`
  - `const KNOWN_API_KEY_ENVS: readonly string[]` = `['DEEPSEEK_API_KEY']`
  - `parseChain(text: string): { chain: Chain } | { error: string }`
  - `defaultChain(models: { claudeModel: string; deepseekModel: string }): Chain`
  - `matchStepByModel(chain: Chain, model: string): ChainStep | null`
  - `chainIdOf(text: string): string`

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'claude-code/testing'
import { defaultChain, matchStepByModel, parseChain } from './chain'

const CLAUDE = {
  id: 'claude', label: 'Claude', model: 'Claude Code API/claude-opus-5-5[1m]',
  meter: { type: 'claude-oauth', exhaust_at: { five_hour: 90 }, pause_at: { seven_day: 90 }, resume_below: { five_hour: 5 } },
}
const DEEPSEEK = {
  id: 'deepseek', label: 'DeepSeek', model: 'DeepSeek/deepseek-flash',
  meter: { type: 'deepseek-balance', api_key_env: 'DEEPSEEK_API_KEY',
    exhaust_below: { amount: 2, currency: 'USD' }, resume_above: { amount: 3, currency: 'USD' } },
}
const good = () => JSON.stringify([CLAUDE, DEEPSEEK])

test('a valid chain parses and gets a stable id', () => {
  const a = parseChain(good())
  const b = parseChain(good())
  expect('chain' in a && a.chain.steps.map(s => s.id)).toEqual(['claude', 'deepseek'])
  expect('chain' in a && 'chain' in b && a.chain.id === b.chain.id).toBe(true)
})

test('a changed chain gets a different id', () => {
  const a = parseChain(good())
  const b = parseChain(JSON.stringify([CLAUDE]))
  expect('chain' in a && 'chain' in b && a.chain.id === b.chain.id).toBe(false)
})

test('invalid chains are refused whole with a reason', () => {
  const cases: [string, RegExp][] = [
    ['not json', /JSON/],
    ['{}', /array/],
    ['[]', /empty|at least one/],
    [JSON.stringify([{ ...CLAUDE, id: 'Bad Id' }]), /id/],
    [JSON.stringify([CLAUDE, { ...DEEPSEEK, id: 'claude' }]), /duplicate/i],
    [JSON.stringify([{ ...CLAUDE, model: '' }]), /model/],
    [JSON.stringify([{ ...CLAUDE, meter: { type: 'nope' } }]), /meter/],
    [JSON.stringify([{ ...CLAUDE, meter: { type: 'deepseek-balance', api_key_env: 'OTHER_KEY', exhaust_below: { amount: 2, currency: 'USD' } } }]), /DEEPSEEK_API_KEY/],
  ]
  for (const [text, pattern] of cases) {
    const r = parseChain(text)
    expect('error' in r && pattern.test(r.error)).toBe(true)
  }
})

test('the default chain is Claude then DeepSeek with the old thresholds', () => {
  const c = defaultChain({ claudeModel: 'Claude Code API/claude-opus-5-5[1m]', deepseekModel: 'DeepSeek/deepseek-flash' })
  expect(c.steps.map(s => s.id)).toEqual(['claude', 'deepseek'])
  expect(c.steps[0].meter.exhaust_at).toEqual({ five_hour: 90 })
  expect(c.steps[1].model).toBe('DeepSeek/deepseek-flash')
})

test('model matching tolerates case and a trailing context suffix', () => {
  const c = defaultChain({ claudeModel: 'Claude Code API/claude-opus-5-5[1m]', deepseekModel: 'DeepSeek/deepseek-flash' })
  expect(matchStepByModel(c, 'claude code api/claude-opus-5-5')?.id).toBe('claude')
  expect(matchStepByModel(c, 'DeepSeek/DeepSeek-Flash')?.id).toBe('deepseek')
  expect(matchStepByModel(c, 'gpt-5')).toBeNull()
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `claude plugin test plugin/usage-relay`
Expected: FAIL — cannot resolve `./chain`.

- [ ] **Step 3: Implement `chain.ts`**

Parse with `JSON.parse` inside try/catch. Validate in order: array → non-empty → each step's `id` matches `/^[a-z0-9_-]+$/` and is unique → `label` defaults to `id` → `model` non-empty string → `meter.type` in the registry → per type: `claude-oauth` requires numeric `exhaust_at.five_hour`; `deepseek-balance` requires `api_key_env` in `KNOWN_API_KEY_ENVS`, `exhaust_below.amount` numeric and `exhaust_below.currency` string, optional `resume_above` with the same shape; `session-spend` requires numeric `exhaust_at_usd`. Errors are one sentence, naming the step index or id. `chainIdOf` is FNV-1a over the canonical `JSON.stringify` of the parsed steps, hex, 8 chars. `matchStepByModel` lowercases both sides, strips a trailing `[...]`, and compares equal or prefix-with-`/…`; returns null when nothing matches. `defaultChain` builds the two steps above from the given models with `exhaust_at.five_hour: 90`, `pause_at.seven_day: 90`, `resume_below.five_hour: 5`, and DeepSeek `exhaust_below: { amount: 2, currency: 'USD' }`, `resume_above: { amount: 3, currency: 'USD' }`, `api_key_env: 'DEEPSEEK_API_KEY'`.

- [ ] **Step 4: Run and watch them pass**

Run: `claude plugin test plugin/usage-relay`
Expected: PASS (6 new tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/usage-relay/hooks/lib/chain.ts plugin/usage-relay/hooks/lib/chain.test.ts
git commit -m "feat: chain file parsing and validation

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Meter readings

**Files:**
- Create: `plugin/usage-relay/hooks/lib/meters.ts`
- Create: `plugin/usage-relay/hooks/lib/meters.test.ts`

**Interfaces:**
- Consumes: `ChainStep` from Task 1; `Snapshot`, `fiveHourKey`, `sevenDayKey` from `usage.ts`.
- Produces:
  - `type MeterReading = { exhausted: boolean; available: boolean; gate: { kind: 'seven_day'; detail: string } | null; summary: string; fetchedAt: number; stale: boolean; fiveHourKey: string; sevenDayKey: string }`
  - `type MeterInputs = { usage: Snapshot | null; balances: Record<string, unknown>; spendUsd: number | null; isCurrent: boolean }`
  - `readMeter(step: ChainStep, inputs: MeterInputs, now: number): MeterReading`
  - `staleReading(summary: string, now: number): MeterReading`

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run and watch them fail**

Run: `claude plugin test plugin/usage-relay`
Expected: FAIL — cannot resolve `./meters`.

- [ ] **Step 3: Implement `meters.ts`**

`readMeter` switches on `step.meter.type`.
- `claude-oauth`: no usage or `usage.stale` → `staleReading('usage unavailable', now)`. Otherwise `exhausted = fiveHour >= exhaust_at.five_hour`; `gate` when `sevenDay >= pause_at.seven_day`, detail `` `Weekly usage is at ${Math.round(sevenDay)}% of the 7-day cap. Work paused; run /relay resume or wait for the reset.` ``; `available = !gate && fiveHour <= resume_below.five_hour`; summary `` `5h ${Math.round(fiveHour)}% · 7d ${Math.round(sevenDay)}%` ``; `fiveHourKey`/`sevenDayKey` from `usage.ts`.
- `deepseek-balance`: key = `inputs.balances[api_key_env]`; absent → `staleReading(\`no key: ${api_key_env}\`, now)`. Parse `balance_infos`, find `currency` equal (case-insensitive) to `exhaust_below.currency`; none → `staleReading(\`no ${currency} balance; currencies: ${list}\`, now)`. `amount = Number(total_balance)`; `exhausted = amount < exhaust_below.amount`; `available = amount >= (resume_above?.amount ?? exhaust_below.amount + 1)`; summary `` `$${amount.toFixed(2)} left` ``; gate null; keys `''`.
- `session-spend`: `!inputs.isCurrent` → `{ exhausted: false, available: true, gate: null, summary: 'session spend (n/a)', fetchedAt: now, stale: false, fiveHourKey: '', sevenDayKey: '' }`; else `spendUsd === null` → `staleReading('session cost unavailable', now)`; `exhausted = spendUsd >= exhaust_at_usd`; `available: true`; summary `` `session $${spendUsd.toFixed(2)}` ``.
`staleReading(summary, now)` returns `{ exhausted: false, available: false, gate: null, summary, fetchedAt: now, stale: true, fiveHourKey: '', sevenDayKey: '' }`.

- [ ] **Step 4: Run and watch them pass**

Run: `claude plugin test plugin/usage-relay`
Expected: PASS (8 new tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/usage-relay/hooks/lib/meters.ts plugin/usage-relay/hooks/lib/meters.test.ts
git commit -m "feat: meter readings for claude, deepseek balance and session spend

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Chain selection and transitions

**Files:**
- Create: `plugin/usage-relay/hooks/lib/chainstate.ts`
- Create: `plugin/usage-relay/hooks/lib/chainstate.test.ts`

**Interfaces:**
- Consumes: `Chain`, `ChainStep` (Task 1); `MeterReading` (Task 2).
- Produces:
  - `type ChainPhase = 'idle' | 'handoff_pending' | 'switched'`
  - `type ChainState = { chainId: string; windowKey: string; phase: ChainPhase; owner: string | null; ownerSeenAt: number; requestedAt: number | null; fromStepId: string | null; toStepId: string | null; pausedUntil: number; sevenDayAck: string | null; notifiedAll: string | null }`
  - `const initialChainState: ChainState`
  - `type ChainInput = { now: number; sessionId: string; stepId: string; chain: Chain; state: ChainState; readings: Record<string, MeterReading>; turnIdle: boolean; handoffMtimeMs: number | null; leaseMs?: number }`
  - `type ChainResult = { state: ChainState; requestHandoff: { from: string; to: string } | null; launch: { stepId: string } | null; blocked: { kind: 'seven_day'; detail: string } | null; notify: string | null }`
  - `evaluateChain(input: ChainInput): ChainResult`
  - `acknowledgeSevenDay(state: ChainState, key: string): ChainState`
  - `moveTo(state: ChainState, from: string, to: string, now: number, sessionId: string): ChainState` (used by `/relay next` and `/relay back`)
  - `lockKeyFor(state: ChainState): string` — `chainId-from-to-windowKey`, non-alphanumerics replaced with `-`
  - `isStaleLock(mtimeMs: number | null, now: number, leaseMs: number): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'claude-code/testing'
import { evaluateChain, initialChainState, moveTo } from './chainstate'
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
  const busy = evaluateChain(base({ state: pending, handoffMtimeMs: NOW, turnIdle: false }))
  expect(busy.launch).toBeNull()
  const launched = evaluateChain(base({ state: pending, handoffMtimeMs: NOW, turnIdle: true }))
  expect(launched.launch).toEqual({ stepId: 'deepseek' })
  expect(launched.state.phase).toBe('switched')
  const after = evaluateChain(base({
    state: launched.state, handoffMtimeMs: NOW,
    readings: { claude: R({ exhausted: true }), deepseek: R() },
  }))
  expect(after.launch).toBeNull()
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
  const owned = { ...initialChainState, chainId: 'c1', phase: 'handoff_pending' as const,
    owner: 'dead', ownerSeenAt: NOW - 700_000, requestedAt: NOW - 700_000, fromStepId: 'claude', toStepId: 'deepseek' }
  const r = evaluateChain(base({ sessionId: 's2', state: owned,
    readings: { claude: R({ exhausted: true }), deepseek: R() } }))
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
```

- [ ] **Step 2: Run and watch them fail**

Run: `claude plugin test plugin/usage-relay`
Expected: FAIL — cannot resolve `./chainstate`.

- [ ] **Step 3: Implement `chainstate.ts`**

`evaluateChain` in this order: reset when `state.chainId !== chain.id` (fresh `initialChainState` with the new id); lease takeover; pick the current reading; apply rule order from the spec (stale → stay; gate → `blocked` with the gate detail; not exhausted → stay; earlier `available && !stale` → move back; later `!exhausted && !stale` → move forward; else notify once keyed by `chain.id + sevenDayKey` of the current reading via `notifiedAll`). Ownership: a move is only claimed when this session is the owner, the state is `idle`/`switched`, or the lease expired; a pending move owned by another live session returns quiet. Launch when `handoff_pending && owner === sessionId && handoffMtimeMs >= requestedAt && turnIdle`, producing `phase: 'switched'` and `notify: 'Moving from X to Y'`. `windowKey` records the current reading's `fiveHourKey`. `acknowledgeSevenDay` sets `sevenDayAck`. `moveTo` sets phase/from/to/requestedAt and `owner: sessionId`. `lockKeyFor` builds the lock name from the pending move. `isStaleLock` is true only when a lock exists and its mtime is older than the lease.

- [ ] **Step 4: Run and watch them pass**

Run: `claude plugin test plugin/usage-relay`
Expected: PASS (11 new tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/usage-relay/hooks/lib/chainstate.ts plugin/usage-relay/hooks/lib/chainstate.test.ts
git commit -m "feat: chain selection, gating and transitions

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Per-step launcher

**Files:**
- Modify: `plugin/usage-relay/hooks/lib/launch.ts`
- Modify: `plugin/usage-relay/hooks/lib/launch.test.ts`

**Interfaces:**
- Consumes: `ChainStep` (Task 1), `Config` (`terminal`, `handoffFile`).
- Produces: `buildLaunchArgv(spec: { root: string; step: ChainStep; chainFile: string; config: Config }): string[]` (replaces the `target: 'claude' | 'deepseek'` form).

- [ ] **Step 1: Replace the launch tests**

Keep the encoded-command and single-quote tests; replace the model assertions with:

```ts
const step: ChainStep = { id: 'deepseek', label: 'DeepSeek', model: 'DeepSeek/deepseek-flash', meter: { type: 'session-spend' } }

test('a launch sets the step and chain file, and runs the step model', () => {
  const argv = buildLaunchArgv({ root: 'C:/w', step, chainFile: 'C:/chain.json', config })
  const decoded = decode(argv[9])
  expect(decoded).toContain("USAGE_RELAY_STEP='deepseek'")
  expect(decoded).toContain("USAGE_RELAY_CHAIN_FILE='C:/chain.json'")
  expect(decoded).toContain("--model 'DeepSeek/deepseek-flash'")
  expect(decoded).toContain("'Read HANDOFF.md in this directory and continue the work it describes.'")
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `claude plugin test plugin/usage-relay`
Expected: FAIL — `buildLaunchArgv` has no `step`.

- [ ] **Step 3: Implement**

Build `` `$env:USAGE_RELAY_STEP=${quoted(step.id)}; $env:USAGE_RELAY_CHAIN_FILE=${quoted(chainFile)}; & claude --model ${quoted(step.model)} ${quoted(initialPrompt(config.handoffFile))}` `` and encode it as today. Keep `quoted` throwing on a single quote and the `-EncodedCommand` argv shape.

- [ ] **Step 4: Run and watch them pass**

Run: `claude plugin test plugin/usage-relay`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/usage-relay/hooks/lib/launch.ts plugin/usage-relay/hooks/lib/launch.test.ts
git commit -m "feat: launch a chain step

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Wire the chain

**Files:**
- Modify: `plugin/usage-relay/hooks/register.tsx`
- Modify: `plugin/usage-relay/hooks/lib/config.ts` (add `chainFile`, `deepseekApiKey`, `fakeMeters`; drop the threshold fields)
- Create: `plugin/usage-relay/hooks/register.chain.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: the running chain; store keys `usage` (Snapshot), `meters` (readings), `relay` (ChainState).

- [ ] **Step 1: Configuration**

`Config` gains `chainFile: string` (default `<USERPROFILE>/.claude/usage-relay/chain.json`, overridden by `USAGE_RELAY_CHAIN_FILE` or `userConfig.chain_file`), `deepseekApiKey: string | null` (`userConfig.deepseek_api_key`), and `fakeMeters: Record<string, { exhausted?: boolean; available?: boolean }> | null` (from `USAGE_RELAY_FAKE_METERS`, JSON, invalid → null). Remove `fiveHourThreshold`, `resumeBelow`, `sevenDayThreshold`, `fakeFiveHour`, `fakeSevenDay` and `role`; keep `handoffFile`, `claudeModel`, `deepseekModel`, `terminal`, `pollSeconds`, `enabled`. Update `config.test.ts` for the new fields. Delete the superseded `hooks/lib/state.ts` and `state.test.ts` (the chain machine replaces them) after Task 3's tests are green; `gate.ts`, `reason.ts`, `usage.ts`, `launch.ts` stay.

- [ ] **Step 2: Session start**

Resolve `stepId` from `USAGE_RELAY_STEP`, else `matchStepByModel(chain, model)`, else `null`. Read the chain: `$.fs.read(chainFile)`; missing or invalid → a chain-less session whose status line is `usage-relay: <error>` and which never gates or moves. Register `/relay` with `status|next|back|reload|pause|resume|reset|meters|test on|off`. Start the tick.

- [ ] **Step 3: Tick**

Gather once per tick: Claude usage (existing endpoint logic; also when a `claude-oauth` step exists and the token is usable), DeepSeek balance (`$.http.fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: `Bearer ${key}` } })` for each balance step, key from `$.env.get('DEEPSEEK_API_KEY')` then `config.deepseekApiKey`), and spend (`(await $.session.usage()).cost?.usd ?? null`). Build `readings` with `readMeter` per step (`isCurrent` only for `stepId`), apply `fakeMeters` overrides after reading, call `evaluateChain`, write `relay`/`meters`/`usage`, render
`` `[${index + 1}/${steps.length}] ${label} · ${summary}${next ? ` · next ${next}` : ''}` ``, and act: `requestHandoff` appends the existing handoff text; `blocked.kind === 'seven_day'` sets the status to the gate detail; `launch` claims the lock (key `chainId-from-to-windowKey`, stale locks reaped after the lease, failed launch deletes the lock and returns the state to idle) and runs `buildLaunchArgv`.

- [ ] **Step 4: Gate, Stop and commands**

`tool.call` blocks when this session owns a `handoff_pending` (handoff kind) or the current reading has a `seven_day` gate; deny text comes from the gate detail or `handoffReason`. `classic.Stop` blocks once while pending and the handoff is missing or older than `requestedAt`, statting the file at the call site. `/relay next` and `/relay back` use `moveTo`; `reload` re-reads the file; `meters` prints every reading plus `stale` reason; `test on|off` sets a session-local fake that forces the current step exhausted.

- [ ] **Step 5: Integration tests**

`register.chain.test.ts`, using `mock.env` and hooks beneath for `fs.read` (chain JSON), `session.usage` (cost), `http.fetch` (usage/balance) and `process.run`:

```ts
test('a claude session at 95% denies tools and asks for a handoff', async ($, on) => { /* env USAGE_RELAY_STEP=claude, chain two steps, claude reading 95 */ })
test('a session whose chain file is invalid never gates', async ($, on) => { /* fs.read returns 'not json'; Bash allowed; status names the error */ })
test('a 7d gate denies writes but allows reads', async ($, on) => { /* ... */ })
```

- [ ] **Step 6: Validate and run**

Run: `claude plugin validate plugin/usage-relay` → no engine errors.
Run: `claude plugin test plugin/usage-relay` → all pass.

- [ ] **Step 7: Commit**

```bash
git add plugin/usage-relay/hooks/register.tsx plugin/usage-relay/hooks/lib/config.ts plugin/usage-relay/hooks/register.chain.test.ts
git commit -m "feat: wire the configurable chain

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Manifest, docs and migration

**Files:**
- Modify: `plugin/usage-relay/.claude-plugin/plugin.json` (0.2.0; drop threshold fields; add `chain_file`, `deepseek_api_key` with `"sensitive": true`)
- Create: `plugin/usage-relay/METERS.md`
- Create: `plugin/usage-relay/chain.example.json`
- Modify: `plugin/usage-relay/README.md`
- Modify: `README.md` (root) with a one-paragraph chain description

**Interfaces:**
- Consumes: the chain schema from Task 1.
- Produces: documentation a contributor can add a provider from, and an upgrade note.

- [ ] **Step 1: Manifest and example**

Version `0.2.0`; `userConfig`: `chain_file` (string, default `''` = `%USERPROFILE%/.claude/usage-relay/chain.json`), `handoff_file`, `terminal`, `poll_seconds`, `enabled`, `deepseek_api_key` (`{"type":"string","sensitive":true,...}`). Remove `five_hour_threshold`, `resume_below`, `seven_day_threshold`. `chain.example.json` is the two-step example from the spec.

- [ ] **Step 2: METERS.md**

Document the `MeterReading` contract, the three v1 meters and their fields, the literal-env-key rule, and the four-step recipe for a new provider (literal env name + manifest field, inline fetch branch, pure reader, table/test).

- [ ] **Step 3: READMEs and migration**

Plugin README: chain configuration, `/relay` commands, secrets, fake meters. Upgrade note: thresholds moved into the chain file; an existing install with no chain file uses the built-in default (Claude 90/5 → DeepSeek at $2). Root README: one paragraph on the chain.

- [ ] **Step 4: Validate and commit**

Run: `claude plugin validate plugin/usage-relay`
```bash
git add plugin/usage-relay README.md
git commit -m "docs: chain configuration, meters and migration to 0.2.0

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: End-to-end with fake meters

**Files:**
- Modify: `docs/e2e-checklist.md`

- [ ] **Step 1: Fake-meter move**

In a scratch repo: `USAGE_RELAY_STEP=claude USAGE_RELAY_FAKE_METERS='{"claude":{"exhausted":true,"available":false},"deepseek":{"exhausted":false,"available":true}}' claude -p --permission-mode acceptEdits "Run bash echo hi."` Expected: deny, `HANDOFF.md`, a new tab running the DeepSeek step with `USAGE_RELAY_STEP=deepseek`, no second tab.

- [ ] **Step 2: Return move**

In the DeepSeek step: `USAGE_RELAY_FAKE_METERS='{"claude":{"exhausted":false,"available":true},"deepseek":{}}'` → the return request appears and, with acceptEdits, a Claude tab opens once.

- [ ] **Step 3: Real DeepSeek balance read (needs the person's key)**

With `DEEPSEEK_API_KEY` set, `/relay meters` in a tab shows a dollar summary, not `stale`. Record the real response shape in `METERS.md`; adjust the parser if it differs.

- [ ] **Step 4: Record and commit**

```bash
git add docs/e2e-checklist.md plugin/usage-relay/METERS.md
git commit -m "docs: chain end-to-end results

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
