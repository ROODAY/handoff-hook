# Usage Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code mod that watches the 5-hour Claude usage window and relays work between Claude and DeepSeek sessions with a written handoff, inside the normal interactive TUI.

**Architecture:** One function-hook plugin loaded in every session. Pure modules hold all decisions (config, usage parsing, state machine, tool gate, launcher argv); `register.tsx` is thin wiring that polls, writes shared state to `$.store`, renders status, gates tool calls, and launches the successor session in a new Windows Terminal tab.

**Tech Stack:** TypeScript hooks module (Claude Code mod API 2.1.312, early access), `claude plugin test` + `claude plugin validate`, PowerShell 7, Windows Terminal, Node 24.

**Spec:** `docs/superpowers/specs/2026-10-27-usage-relay-design.md`

## Global Constraints

- Windows 11 only. No new npm dependencies; no build step. Hooks are `.ts`/`.tsx` loaded by the engine.
- Never print, log, store or commit OAuth tokens, API keys, or CCR config contents.
- Never modify `~/.claude/settings.json` or `~/.config/claude-code-router` / `%APPDATA%\claude-code-router` files.
- All new files live under `plugin/usage-relay/` except the marketplace file `.claude-plugin/marketplace.json` at the repo root, `docs/`, and throwaway code under `scratch/` (gitignored).
- Directory pinned to `$.session.root()`; handoff path is `<root>/<handoff_file>`.
- Defaults: `five_hour_threshold` 90, `resume_below` 5, `seven_day_threshold` 90, `poll_seconds` 60, `handoff_file` `HANDOFF.md`, `claude_model` `Claude Code API/claude-opus-5-5[1m]`, `deepseek_model` `DeepSeek/deepseek-flash`.
- 7-day threshold blocks tools (reads allowed), never switches, and is acknowledged per weekly window with `/relay resume`.
- Every guard hook registers `.catch` and answers `{ deny }` when its own logic fails (fail closed).
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

1. Gateway sessions may report no rate limits (`$.session.usage().rateLimits` empty) and the credentials token may be missing or near expiry → the tick must do nothing and keep the last status rather than crash or switch. Test in Task 3.
2. Two Claude sessions over the threshold → exactly one handoff request, the other is never gated. Test in Task 4.
3. A tool call writing `HANDOFF.md` with Windows backslashes or different case must be allowed while pending; a write to any other file denied. Test in Task 5.
4. `resets_at` drifting between polls must not mint a new window key and re-fire the guard. Test in Task 3.
5. `/relay resume` at 7d must hold for that weekly window only and re-arm automatically on the next one. Test in Task 4.

---

### Task 1: Spike the risky assumptions

**Files:**
- Create: `scratch/spike/plugin.json` (throwaway probe mod, gitignored)
- Create: `scratch/spike/register.tsx` (throwaway)
- Create: `docs/spike-results.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `docs/spike-results.md` with a line per question and a verdict, which Tasks 3, 4 and 7 read before choosing the usage source and the lock mechanism. If a verdict contradicts the spec, stop and report to the person before continuing.

- [ ] **Step 1: Write the probe mod**

`scratch/spike/plugin.json`:
```json
{ "name": "usage-relay-spike", "version": "0.0.1", "description": "throwaway probe" }
```

`scratch/spike/register.tsx` (writes one JSON file per session every 5 seconds and on `session.measure`):
```tsx
import type { Register } from 'claude-code'

export const register: Register = on => {
  let sessionId = 'unknown'
  const write = async ($: any) => {
    const role = (await $.env.get('USAGE_RELAY_ROLE')) ?? 'none'
    const usage = await $.session.usage()
    const other = await $.store.get('probe')
    await $.store.set('probe', { sessionId, at: Date.now() })
    await $.fs.write(
      `C:/Users/Rudhra/Code/handoff-hook/scratch/spike-${role}.json`,
      JSON.stringify({ role, sessionId, other, root: await $.session.root(), model: await $.session.model(), usage }, null, 1),
    )
  }
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    await write($)
    $.clock.every(5000, () => write($))
    return next(e)
  })
  on('session.measure', async ($, e, next) => {
    await write($)
    return next(e)
  })
}
```

- [ ] **Step 2: Validate it**

Run: `claude plugin validate scratch/spike`
Expected: no errors, listing the `session.start` and `session.measure` hooks.

- [ ] **Step 3: Ask the person to run two sessions with the probe**

Ask them to run, in this repo, one tab each:
```
set USAGE_RELAY_ROLE=claude && claude --plugin-dir scratch/spike
set USAGE_RELAY_ROLE=deepseek && claude --plugin-dir scratch/spike --model DeepSeek/deepseek-flash
```
and to type one short prompt in each. They answer the mods prompt ("Turn on the mods Claude writes in this session?") only if it appears.

- [ ] **Step 4: Read the probe output**

Run: `node -e "for (const r of ['claude','deepseek']) { const f='scratch/spike-'+r+'.json'; try { const j=require('./'+f); console.log(r, 'rateLimits=', JSON.stringify(j.usage.rateLimits), 'root=', j.root, 'model=', j.model) } catch(e) { console.log(r,'missing') } }"`
Expected: at least the `claude` file exists; note whether `rateLimits` is non-empty and whether `resetsAt` changes between dumps.

- [ ] **Step 5: Test store visibility across sessions**

Temporarily make the probe `$.store.set('probe', { sessionId, at: Date.now() })` in `write`, reload both tabs with `/reload-plugins`, and have the person confirm each tab's dump shows the other session's value in `$.store.get('probe')` (add that read to the dump). Record the verdict: live/shared or not.

- [ ] **Step 6: Test the launch path**

From a normal shell run:
```
wt -w 0 new-tab -d C:/Users/Rudhra/Code/handoff-hook pwsh -NoExit -Command "$env:USAGE_RELAY_ROLE='claude'; & claude 'Reply with the single word SPIKE-OK and stop.'"
```
Expected: a new tab opens in the repo, starts Claude interactively, and the model answers `SPIKE-OK`. Note whether the tab requires a prompt to continue (it should not).

- [ ] **Step 7: Write the findings and commit**

Write `docs/spike-results.md` with one line per question: usage source (session vs endpoint), store cross-session visibility (live / not live), `resets_at` stability, launch command works, deny visible in auto mode (observed in step 3 by adding a temporary `on('tool.call', {tool:'Bash'}, () => ({deny:'spike deny'}))`), stop-block behaviour.

```bash
git add docs/spike-results.md
git commit -m "docs: spike results for usage source, store and launch

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Plugin skeleton and install path

**Files:**
- Create: `plugin/usage-relay/.claude-plugin/plugin.json`
- Create: `plugin/usage-relay/hooks/hooks.json`
- Create: `plugin/usage-relay/hooks/register.tsx`
- Create: `.claude-plugin/marketplace.json`
- Create: `plugin/usage-relay/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a loadable plugin named `usage-relay` with `userConfig` fields every later task reads through `readConfig` (Task 3): `five_hour_threshold`, `resume_below`, `seven_day_threshold`, `poll_seconds`, `handoff_file`, `claude_model`, `deepseek_model`, `enabled`.

- [ ] **Step 1: Write the manifest**

`plugin/usage-relay/.claude-plugin/plugin.json`:
```json
{
  "name": "usage-relay",
  "version": "0.1.0",
  "description": "Watches Claude usage and relays work to a DeepSeek session with a written handoff, then back.",
  "userConfig": {
    "five_hour_threshold": { "type": "number", "title": "5-hour switch threshold (%)", "default": 90 },
    "resume_below": { "type": "number", "title": "Return to Claude below (%)", "default": 5 },
    "seven_day_threshold": { "type": "number", "title": "7-day tool-block threshold (%)", "default": 90 },
    "poll_seconds": { "type": "number", "title": "Poll period (seconds)", "default": 60 },
    "handoff_file": { "type": "string", "title": "Handoff file name", "default": "HANDOFF.md" },
    "claude_model": { "type": "string", "title": "Claude model for the return trip", "default": "Claude Code API/claude-opus-5-5[1m]" },
    "deepseek_model": { "type": "string", "title": "DeepSeek model for the outbound trip", "default": "DeepSeek/deepseek-flash" },
    "enabled": { "type": "boolean", "title": "Enabled", "default": true }
  }
}
```

`plugin/usage-relay/hooks/hooks.json`:
```json
{ "modules": ["./register.tsx"] }
```

- [ ] **Step 2: Write the minimal hooks module**

`plugin/usage-relay/hooks/register.tsx`:
```tsx
import type { PluginOptions, Register } from 'claude-code'

export const register: Register = (on, _options: PluginOptions) => {
  on('session.start', ($, e, next) => {
    $.ui.status('usage-relay loaded')
    return next(e)
  })
}
```

- [ ] **Step 3: Validate**

Run: `claude plugin validate plugin/usage-relay`
Expected: no errors, and the report lists `session.start`.

- [ ] **Step 4: Write the marketplace file**

`.claude-plugin/marketplace.json`:
```json
{
  "name": "handoff-hook",
  "owner": { "name": "Rudhra" },
  "plugins": [{ "name": "usage-relay", "source": "./plugin/usage-relay" }]
}
```

- [ ] **Step 5: Install from the folder and confirm it loads**

Run: `claude plugin marketplace add C:/Users/Rudhra/Code/handoff-hook`
then `claude plugin install usage-relay@handoff-hook --scope user`
Expected: "Installed usage-relay". Open a new tab and run `claude`; the status line under the prompt reads `usage-relay loaded`. If the CLI rejects the flags, run `/plugin` interactively and note the exact working command in `plugin/usage-relay/README.md`.

- [ ] **Step 6: Write the README install section**

`plugin/usage-relay/README.md` with: install command, `/config` fields, how to test with `USAGE_RELAY_FAKE_5H`, and uninstall (`claude plugin uninstall usage-relay`, `claude plugin marketplace remove handoff-hook`).

- [ ] **Step 7: Commit**

```bash
git add plugin/usage-relay .claude-plugin/marketplace.json
git commit -m "feat: usage-relay plugin skeleton and install path

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Config and usage parsing

**Files:**
- Create: `plugin/usage-relay/hooks/lib/config.ts`
- Create: `plugin/usage-relay/hooks/lib/config.test.ts`
- Create: `plugin/usage-relay/hooks/lib/usage.ts`
- Create: `plugin/usage-relay/hooks/lib/usage.test.ts`

**Interfaces:**
- Consumes: `PluginOptions` from `claude-code`.
- Produces:
  - `type Role = 'claude' | 'deepseek' | 'none'`
  - `type Config = { fiveHourThreshold: number; resumeBelow: number; sevenDayThreshold: number; pollSeconds: number; handoffFile: string; claudeModel: string; deepseekModel: string; enabled: boolean; role: Role; fakeFiveHour: number | null; fakeSevenDay: number | null }`
  - `readConfig(options: PluginOptions, env: Record<string, string | undefined>): Config`
  - `type Snapshot = { fiveHour: number | null; fiveHourResetsAt: number | null; sevenDay: number | null; sevenDayResetsAt: number | null; fetchedAt: number; source: 'session' | 'endpoint' | 'fake'; stale: boolean }`
  - `parseUsageResponse(text: string, now: number): Snapshot | null`
  - `fromSessionRateLimits(limits: readonly SessionRateLimit[], now: number): Snapshot | null`
  - `fakeSnapshot(config: Config, now: number): Snapshot | null`
  - `readToken(credentialsText: string, now: number): string | null`
  - `fiveHourKey(s: Snapshot): string`
  - `sevenDayKey(s: Snapshot): string`

- [ ] **Step 1: Write the failing config test**

`config.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'
import { readConfig } from './config'

test('defaults fill in when options are empty', () => {
  const c = readConfig({}, {})
  expect(c.fiveHourThreshold).toBe(90)
  expect(c.sevenDayThreshold).toBe(90)
  expect(c.role).toBe('none')
  expect(c.enabled).toBe(true)
})

test('env overrides options and role is read from USAGE_RELAY_ROLE', () => {
  const c = readConfig({ five_hour_threshold: 80 }, {
    USAGE_RELAY_ROLE: 'deepseek',
    USAGE_RELAY_5H: '85',
    USAGE_RELAY_FAKE_5H: '95',
  })
  expect(c.fiveHourThreshold).toBe(85)
  expect(c.role).toBe('deepseek')
  expect(c.fakeFiveHour).toBe(95)
})

test('USAGE_RELAY_DISABLED turns the guard off', () => {
  expect(readConfig({}, { USAGE_RELAY_DISABLED: '1' }).enabled).toBe(false)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `claude plugin test plugin/usage-relay`
Expected: FAIL — cannot resolve `./config`.

- [ ] **Step 3: Implement `config.ts`**

`readConfig` reads each field from `options` with the manifest defaults, applies env overrides (`USAGE_RELAY_5H`, `USAGE_RELAY_7D`, `USAGE_RELAY_POLL`, `USAGE_RELAY_HANDOFF`, `USAGE_RELAY_CLAUDE_MODEL`, `USAGE_RELAY_DEEPSEEK_MODEL`, `USAGE_RELAY_DISABLED`, `USAGE_RELAY_ROLE`, `USAGE_RELAY_FAKE_5H`, `USAGE_RELAY_FAKE_7D`), parses numbers with `Number`, and treats a non-finite number as unset. Role is `'claude' | 'deepseek'` when `USAGE_RELAY_ROLE` matches, else `'none'`. `enabled` is false when `options.enabled` is false or `USAGE_RELAY_DISABLED` is `'1'`.

- [ ] **Step 4: Run it and watch it pass**

Run: `claude plugin test plugin/usage-relay`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing usage tests**

`usage.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'
import { fiveHourKey, parseUsageResponse, fromSessionRateLimits } from './usage'

const NOW = 1_800_000_000_000
const BODY = JSON.stringify({
  five_hour: { utilization: 53, resets_at: '2026-10-28T02:30:00.299525+00:00' },
  seven_day: { utilization: 66, resets_at: '2026-10-30T04:00:00.299549+00:00' },
})

test('parses utilization and reset times from the endpoint body', () => {
  const s = parseUsageResponse(BODY, NOW)
  expect(s?.fiveHour).toBe(53)
  expect(s?.sevenDay).toBe(66)
  expect(s?.fiveHourResetsAt).toBe(Date.parse('2026-10-28T02:30:00.299525+00:00'))
  expect(s?.stale).toBe(false)
})

test('returns null for a body with no windows or bad JSON', () => {
  expect(parseUsageResponse('{}', NOW)).toBeNull()
  expect(parseUsageResponse('not json', NOW)).toBeNull()
})

test('reads the session rate limits', () => {
  const s = fromSessionRateLimits([
    { kind: 'five_hour', percentUsed: 91.5, resetsAt: '2026-10-28T02:30:00Z' },
  ], NOW)
  expect(s?.fiveHour).toBe(91.5)
  expect(s?.sevenDay).toBeNull()
  expect(s?.source).toBe('session')
})

test('a reset time that drifts under a minute keeps the same window key', () => {
  const a = parseUsageResponse(BODY, NOW)!
  const b = parseUsageResponse(JSON.stringify({
    five_hour: { utilization: 54, resets_at: '2026-10-28T02:30:30.000000+00:00' },
  }), NOW)!
  expect(fiveHourKey(b)).toBe(fiveHourKey(a))
})

test('a window with no reset time keys as none', () => {
  const s = fromSessionRateLimits([{ kind: 'five_hour', percentUsed: 99 }], NOW)!
  expect(fiveHourKey(s)).toBe('5h:none')
})

test('a token is used only while it has more than two minutes left', () => {
  const creds = (expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt } })
  expect(readToken(creds(NOW + 600_000), NOW)).toBe('tok')
  expect(readToken(creds(NOW + 60_000), NOW)).toBeNull()
  expect(readToken(creds(NOW - 1), NOW)).toBeNull()
  expect(readToken('{}', NOW)).toBeNull()
  expect(readToken('not json', NOW)).toBeNull()
})
```

- [ ] **Step 6: Run and watch them fail**

Run: `claude plugin test plugin/usage-relay`
Expected: FAIL — cannot resolve `./usage`. If the harness reports no tests found at all, tests are not discovered in `hooks/lib/`; move them to `plugin/usage-relay/tests/` (importing `../hooks/lib/usage`) and run again before continuing.

- [ ] **Step 7: Implement `usage.ts`**

`parseUsageResponse` JSON-parses, reads `five_hour.utilization` / `seven_day.utilization` (numbers in 0..100, else null), and `resets_at` via `Date.parse` (NaN → null). Returns null when both utilizations are null. `fetchedAt = now`, `source: 'endpoint'`, `stale: false`. `fromSessionRateLimits` does the same from `SessionRateLimit[]` with `source: 'session'`; returns null when neither kind is present. `fakeSnapshot` returns a snapshot with the fake values when either env fake is set, `source: 'fake'`, reset times null. `readToken` JSON-parses the credentials file, reads `claudeAiOauth.accessToken` (string) and `expiresAt` (epoch ms), and returns the token only when `expiresAt - now > 120_000`; null otherwise, including bad JSON. Key functions: `resetsAt === null ? '5h:none' : '5h:' + Math.round(resetsAt / 60000)` (and `7d:` likewise).

- [ ] **Step 8: Run and watch them pass**

Run: `claude plugin test plugin/usage-relay`
Expected: PASS (9 tests).

- [ ] **Step 9: Commit**

```bash
git add plugin/usage-relay/hooks/lib/config.ts plugin/usage-relay/hooks/lib/config.test.ts plugin/usage-relay/hooks/lib/usage.ts plugin/usage-relay/hooks/lib/usage.test.ts
git commit -m "feat: usage-relay config and usage parsing

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: State machine

**Files:**
- Create: `plugin/usage-relay/hooks/lib/state.ts`
- Create: `plugin/usage-relay/hooks/lib/state.test.ts`

**Interfaces:**
- Consumes: `Config`, `Role`, `Snapshot`, `fiveHourKey`, `sevenDayKey` from Task 3.
- Produces:
  - `type Phase = 'idle' | 'handoff_pending' | 'switched' | 'return_pending' | 'returned'`
  - `type RelayState = { windowKey: string; phase: Phase; owner: string | null; ownerSeenAt: number; requestedAt: number | null; switchedAt: number | null; pausedUntil: number; sevenDayAck: string | null; returnFor: string | null; notifiedSevenDay: string | null }`
  - `const initialRelayState: RelayState`
  - `type EvaluateInput = { now: number; sessionId: string; role: Role; config: Config; snapshot: Snapshot; state: RelayState; handoffMtimeMs: number | null; turnIdle: boolean; leaseMs?: number }`
  - `type EvaluateResult = { state: RelayState; requestHandoff: { direction: 'to_deepseek' | 'to_claude' } | null; launch: { target: 'deepseek' | 'claude' } | null; blocked: { kind: 'handoff' | 'seven_day' } | null; notify: string | null }`
  - `evaluate(input: EvaluateInput): EvaluateResult`
  - `acknowledgeSevenDay(config: Config, snapshot: Snapshot, state: RelayState): RelayState`

- [ ] **Step 1: Write the failing tests**

`state.test.ts` (helper `base` keeps each case one line of difference):
```ts
import { expect, test } from 'claude-code/testing'
import { evaluate, acknowledgeSevenDay, initialRelayState } from './state'
import type { Config } from './config'
import type { Snapshot } from './usage'

const NOW = 1_800_000_000_000
const cfg = (p: Partial<Config> = {}): Config => ({
  fiveHourThreshold: 90, resumeBelow: 5, sevenDayThreshold: 90, pollSeconds: 60,
  handoffFile: 'HANDOFF.md', claudeModel: 'c', deepseekModel: 'd', enabled: true,
  role: 'claude', fakeFiveHour: null, fakeSevenDay: null, ...p,
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
  const owned = { ...initialRelayState, phase: 'handoff_pending' as const,
    owner: 'other', ownerSeenAt: NOW, windowKey: '5h:30000000' }
  const r = evaluate(base({
    sessionId: 's2', snapshot: snap({ fiveHour: 96, fiveHourResetsAt: 1_800_000_000_000 }),
    state: owned,
  }))
  expect(r.requestHandoff).toBeNull()
  expect(r.blocked).toBeNull()
})

test('the owner is gated while the handoff is unwritten, and launches once it is fresh', () => {
  const pending = { ...initialRelayState, phase: 'handoff_pending' as const,
    owner: 's1', ownerSeenAt: NOW, requestedAt: NOW - 1000, windowKey: '5h:30000000' }
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
  const pending = { ...initialRelayState, phase: 'handoff_pending' as const,
    owner: 's1', ownerSeenAt: NOW, requestedAt: NOW - 1000, windowKey: '5h:30000000' }
  const r = evaluate(base({
    snapshot: snap({ fiveHour: 95, fiveHourResetsAt: NOW }), state: pending,
    handoffMtimeMs: NOW, turnIdle: false,
  }))
  expect(r.launch).toBeNull()
})

test('7d blocks tools, notifies once, and /relay resume acknowledges that window', () => {
  const over = snap({ sevenDay: 95 })
  const r = evaluate(base({ snapshot: over }))
  expect(r.blocked).toEqual({ kind: 'seven_day' })
  expect(r.notify).toMatch(/7-day/)
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

test('a stale snapshot does nothing', () => {
  const r = evaluate(base({ snapshot: snap({ fiveHour: 99, stale: true }) }))
  expect(r.requestHandoff).toBeNull()
  expect(r.blocked).toBeNull()
})

test('a pause suppresses action until it passes', () => {
  const paused = { ...initialRelayState, pausedUntil: NOW + 60_000 }
  const r = evaluate(base({ snapshot: snap({ fiveHour: 99 }), state: paused }))
  expect(r.requestHandoff).toBeNull()
  expect(r.blocked).toBeNull()
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `claude plugin test plugin/usage-relay`
Expected: FAIL — cannot resolve `./state`.

- [ ] **Step 3: Implement `state.ts`**

`evaluate` returns `initialRelayState`-derived results unchanged when `!config.enabled`, `role === 'none'`, or `snapshot.stale`. Order of checks:

1. Lease takeover: when `phase === 'handoff_pending'`, `owner !== sessionId`, and `now - ownerSeenAt > (leaseMs ?? 600_000)`, set `owner = sessionId`, `ownerSeenAt = now`.
2. Window rollover: when `fiveHourKey(snapshot) !== state.windowKey` and the 5h value is below threshold, reset to `{ ...initialRelayState, sevenDayAck: state.sevenDayAck, pausedUntil: state.pausedUntil }`.
3. 7d: when `role === 'claude'` and `sevenDay >= config.sevenDayThreshold` and `sevenDayKey(snapshot) !== state.sevenDayAck`, return `blocked: { kind: 'seven_day' }`, `notify` only when `notifiedSevenDay !== sevenDayKey(snapshot)` (then set it), no request, no launch.
4. 5h claim (`role === 'claude'`): when `fiveHour >= fiveHourThreshold` and the window is unclaimed (`owner === null` or `owner === sessionId`) and `phase` is `idle`, set `phase: 'handoff_pending'`, `owner: sessionId`, `ownerSeenAt: now`, `requestedAt: now`, `windowKey: fiveHourKey(snapshot)`, and return `requestHandoff: { direction: 'to_deepseek' }`. When the window is claimed by another live session, return with no request and no block.
5. Owner gating: when `role === 'claude'`, `phase === 'handoff_pending'`, `owner === sessionId`, return `blocked: { kind: 'handoff' }`; when the handoff is fresh (`handoffMtimeMs !== null && handoffMtimeMs >= requestedAt`) and `turnIdle`, return `launch: { target: 'deepseek' }`, `phase: 'switched'`, `switchedAt: now`, `notify: "Claude at N% — DeepSeek session started"`.
6. Return (`role === 'deepseek'`): when `fiveHour <= resumeBelow` and (`fiveHourResetsAt === null || now >= fiveHourResetsAt`) and `returnFor !== fiveHourKey(snapshot)` — or `phase === 'return_pending'` — set `phase: 'return_pending'`, `returnFor: fiveHourKey(snapshot)`, `requestedAt: now`, `owner: sessionId`; return `requestHandoff: { direction: 'to_claude' }` once (when `phase` was not already `return_pending`), else `launch: { target: 'claude' }`, `phase: 'returned'` when the handoff is fresh and `turnIdle`.
7. `pausedUntil > now` clears `requestHandoff`, `launch` and `blocked` at the end.
8. `ownerSeenAt` is refreshed to `now` whenever `owner === sessionId`.

`acknowledgeSevenDay(config, snapshot, state)` returns `{ ...state, sevenDayAck: sevenDayKey(snapshot) }`.

- [ ] **Step 4: Run and watch them pass**

Run: `claude plugin test plugin/usage-relay`
Expected: PASS (10 new tests; 19 total).

- [ ] **Step 5: Commit**

```bash
git add plugin/usage-relay/hooks/lib/state.ts plugin/usage-relay/hooks/lib/state.test.ts
git commit -m "feat: usage-relay state machine and 7d acknowledgement

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Tool gate and reasons

**Files:**
- Create: `plugin/usage-relay/hooks/lib/reason.ts`
- Create: `plugin/usage-relay/hooks/lib/reason.test.ts`
- Create: `plugin/usage-relay/hooks/lib/gate.ts`
- Create: `plugin/usage-relay/hooks/lib/gate.test.ts`

**Interfaces:**
- Consumes: nothing beyond plain values.
- Produces:
  - `const HANDOFF_TEMPLATE: string`
  - `handoffReason(percent: number, handoffFile: string): string`
  - `sevenDayReason(percent: number): string`
  - `handoffReminder(handoffFile: string): string`
  - `type GateInput = { kind: 'handoff' | 'seven_day'; root: string; handoffFile: string }`
  - `gateTool(g: GateInput, tool: string, input: Record<string, unknown>): { deny: string } | null`

- [ ] **Step 1: Write the failing tests**

`reason.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'
import { HANDOFF_TEMPLATE, handoffReason, sevenDayReason } from './reason'

test('the handoff reason carries the template and the ban on chat-isms', () => {
  const r = handoffReason(93.2, 'HANDOFF.md')
  expect(r).toContain('HANDOFF.md')
  expect(r).toContain('93')
  expect(r).toContain(HANDOFF_TEMPLATE)
  expect(r).toContain('no tool-call syntax')
  expect(r).toContain('no references to conversation the reader cannot see')
})

test('the 7d reason says work is paused and names /relay resume', () => {
  const r = sevenDayReason(95)
  expect(r).toContain('7-day')
  expect(r).toContain('/relay resume')
})
```

`gate.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'
import { gateTool } from './gate'

const G = { kind: 'handoff' as const, root: 'C:/work/proj', handoffFile: 'HANDOFF.md' }

test('reads are always allowed while handing off', () => {
  for (const tool of ['Read', 'Glob', 'Grep']) {
    expect(gateTool(G, tool, { file_path: 'C:/work/proj/src/a.ts' })).toBeNull()
  }
})

test('writing the handoff is allowed with any slash style or case', () => {
  for (const p of ['C:/work/proj/HANDOFF.md', 'C:\\work\\proj\\handoff.md', 'HANDOFF.md']) {
    expect(gateTool(G, 'Write', { file_path: p })).toBeNull()
    expect(gateTool(G, 'Edit', { file_path: p })).toBeNull()
  }
})

test('writing any other file is denied', () => {
  expect(gateTool(G, 'Write', { file_path: 'C:/work/proj/src/a.ts' })?.deny)
    .toContain('HANDOFF.md')
})

test('a shell or network tool is denied', () => {
  expect(gateTool(G, 'Bash', { command: 'ls' })?.deny).toBeTruthy()
  expect(gateTool(G, 'WebFetch', { url: 'https://x' })?.deny).toBeTruthy()
})

test('the 7d gate still allows reads and only reads', () => {
  const g = { ...G, kind: 'seven_day' as const }
  expect(gateTool(g, 'Read', { file_path: 'x' })).toBeNull()
  expect(gateTool(g, 'Write', { file_path: 'C:/work/proj/HANDOFF.md' })?.deny).toContain('7-day')
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `claude plugin test plugin/usage-relay`
Expected: FAIL — cannot resolve `./reason` and `./gate`.

- [ ] **Step 3: Implement `reason.ts` and `gate.ts`**

`HANDOFF_TEMPLATE` is exactly:
```markdown
# Handoff
## Goal
## Current status (done / in progress / not started)
## Exact next steps (numbered, concrete, smallest-first)
## Files touched and why (paths)
## Commands to build / test / run
## Decisions made and rationale
## Gotchas, failed approaches, things NOT to do
## Open questions for the user
```
`handoffReason` returns: `` `Usage is at ${percent}% of the 5-hour cap. Stop the current task. Write ${handoffFile} in the project root using the template below, then end your turn. Write plain markdown: no tool-call syntax, no XML tags, no references to conversation the reader cannot see.\n\n${HANDOFF_TEMPLATE}` ``. `sevenDayReason` returns `` `Weekly usage is at ${percent}% of the 7-day cap. Work paused; tell the person to run /relay resume or wait for the reset. Only reading tools are allowed.` ``. `handoffReminder` names the file and says to end the turn.

`gateTool`: normalise `p => p.replace(/\\/g, '/').toLowerCase()`. Allowed tools: `Read`, `Glob`, `Grep`. For `Write` and `Edit`, allow only when the normalised `file_path`, after stripping a leading `${root}/`, equals the normalised `handoffFile`, or the raw value equals `handoffFile` case-insensitively. Everything else: `{ deny: kind === 'seven_day' ? sevenDayReason(...) : handoffReminder(handoffFile) }` (the percent is formatted by the caller; `gateTool` uses the reminder/reason without a percent).

- [ ] **Step 4: Run and watch them pass**

Run: `claude plugin test plugin/usage-relay`
Expected: PASS (7 new tests; 26 total).

- [ ] **Step 5: Commit**

```bash
git add plugin/usage-relay/hooks/lib/reason.ts plugin/usage-relay/hooks/lib/reason.test.ts plugin/usage-relay/hooks/lib/gate.ts plugin/usage-relay/hooks/lib/gate.test.ts
git commit -m "feat: handoff reasons and tool gate

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Launcher argv

**Files:**
- Create: `plugin/usage-relay/hooks/lib/launch.ts`
- Create: `plugin/usage-relay/hooks/lib/launch.test.ts`

**Interfaces:**
- Consumes: `Config` from Task 3.
- Produces:
  - `initialPrompt(): string`
  - `buildLaunchArgv(spec: { root: string; target: 'claude' | 'deepseek'; config: Config }): string[]`

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'claude-code/testing'
import { buildLaunchArgv, initialPrompt } from './launch'
import type { Config } from './config'

const config: Config = {
  fiveHourThreshold: 90, resumeBelow: 5, sevenDayThreshold: 90, pollSeconds: 60,
  handoffFile: 'HANDOFF.md', claudeModel: 'Claude Code API/claude-opus-5-5[1m]',
  deepseekModel: 'DeepSeek/deepseek-flash', enabled: true, role: 'claude',
  fakeFiveHour: null, fakeSevenDay: null,
}

test('a deepseek launch names the tab command, directory, role and model', () => {
  const argv = buildLaunchArgv({ root: 'C:/work/proj', target: 'deepseek', config })
  expect(argv.slice(0, 7)).toEqual(['wt', '-w', '0', 'new-tab', '-d', 'C:/work/proj', 'pwsh'])
  expect(argv[7]).toBe('-NoExit')
  expect(argv[8]).toBe('-Command')
  expect(argv[9]).toBe(
    "$env:USAGE_RELAY_ROLE='deepseek'; & claude --model 'DeepSeek/deepseek-flash' 'Read HANDOFF.md in this directory and continue the work it describes.'",
  )
})

test('a claude launch uses the configured claude model', () => {
  const argv = buildLaunchArgv({ root: 'C:/w', target: 'claude', config })
  expect(argv[9]).toContain("USAGE_RELAY_ROLE='claude'")
  expect(argv[9]).toContain("--model 'Claude Code API/claude-opus-5-5[1m]'")
})

test('the initial prompt is model-neutral and names the handoff', () => {
  expect(initialPrompt()).toBe('Read HANDOFF.md in this directory and continue the work it describes.')
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `claude plugin test plugin/usage-relay`
Expected: FAIL — cannot resolve `./launch`.

- [ ] **Step 3: Implement `launch.ts`**

`initialPrompt()` returns the fixed string above. `buildLaunchArgv` returns exactly:
```
['wt', '-w', '0', 'new-tab', '-d', root, 'pwsh', '-NoExit', '-Command',
 `$env:USAGE_RELAY_ROLE='${target}'; & claude --model '${model}' '${initialPrompt()}'`]
```
where `model` is `config.deepseekModel` for `deepseek` and `config.claudeModel` for `claude`. No shell quoting beyond single quotes; callers reject values containing `'`.

- [ ] **Step 4: Run and watch it pass**

Run: `claude plugin test plugin/usage-relay`
Expected: PASS (3 new tests; 29 total).

- [ ] **Step 5: Commit**

```bash
git add plugin/usage-relay/hooks/lib/launch.ts plugin/usage-relay/hooks/lib/launch.test.ts
git commit -m "feat: windows terminal launch argv

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: Wire the plugin

**Files:**
- Modify: `plugin/usage-relay/hooks/register.tsx` (replace the Task 2 stub)

**Interfaces:**
- Consumes: everything from Tasks 3–6 exactly as their Interfaces blocks name it.
- Produces: the running guard; `/relay` command; status line; store keys `usage` (Snapshot) and `relay` (RelayState).

- [ ] **Step 1: Implement the wiring**

```tsx
import type { PluginOptions, Register } from 'claude-code'
import { readConfig } from './lib/config'
import { parseUsageResponse, fromSessionRateLimits, fakeSnapshot } from './lib/usage'
import { evaluate, initialRelayState, acknowledgeSevenDay, type RelayState } from './lib/state'
import { gateTool } from './lib/gate'
import { buildLaunchArgv } from './lib/launch'
import { handoffReason, sevenDayReason } from './lib/reason'
```

- `session.start`: read env literals with `$.env.get` (`USAGE_RELAY_ROLE`, `USAGE_RELAY_5H`, `USAGE_RELAY_7D`, `USAGE_RELAY_FAKE_5H`, `USAGE_RELAY_FAKE_7D`, `USAGE_RELAY_DISABLED`, `USAGE_RELAY_HANDOFF`, `USAGE_RELAY_CLAUDE_MODEL`, `USAGE_RELAY_DEEPSEEK_MODEL`, `USERPROFILE`), build the config, load `$.store.get('relay')` or `initialRelayState`, register `/relay`, run one tick, then `$.clock.every(config.pollSeconds * 1000, tick)`. Skip the timer when `role === 'none'`.
- `tick`: `fakeSnapshot` first; else for `role === 'claude'` try `$.session.usage()` → `fromSessionRateLimits`; when null, fetch the endpoint (`readToken(await $.fs.read(`${home}/.claude/.credentials.json`), now)`; when null, keep the previous snapshot, mark it stale, and skip the fetch; else `$.http.fetch(url, { headers })`); for `role === 'deepseek'` always the endpoint. On failure keep the previous snapshot and mark `stale: true`. Write `usage` to the store; read the handoff mtime via `$.fs.stat` (null on failure); call `evaluate`; write `relay`; set `$.ui.status` to `` `5h ${n}% · 7d ${m}% · reset ${hh:mm}` `` (or `usage stale`). Apply actions: `requestHandoff` → `$.session.append` a user-role row with the reason (for `to_deepseek`, `handoffReason`; for `to_claude` a short handoff request), and for `to_claude` when `turnIdle` call `$.prompt.submit` too; `launch` → check `$.store.get('relay')` again for `switched`, then `$.process.run(buildLaunchArgv(...), { timeoutMs: 10_000 })` and `$.ui.notify`; `notify` → `$.ui.notify`; `blocked` → `$.ui.status` keeps showing it.
- `tool.call`: when a fresh snapshot and a `relay` state exist, re-run `evaluate` with the cached snapshot and return `gateTool({ kind, root: await $.session.root(), handoffFile }, String(e.tool), e as Record<string, unknown>) ?? next(e)`. The 7d reason comes from `sevenDayReason(percent)`; the handoff deny from `handoffReminder`.
- `turn.start` / `turn.complete`: set `turnIdle` false/true and run `tick` on completion.
- `classic.Stop`: when `relay.phase === 'handoff_pending'`, `owner === sessionId`, the handoff is missing or older than `requestedAt`, and `e.stop_hook_active` is not true → `{ block: handoffReason(percent, config.handoffFile) }`; otherwise `next(e)`.
- `command.run` for `relay`: `status` → snapshot + phase text; `now` → force the claim for this session; `back` → force `return_pending`; `pause` → `pausedUntil = now + 5h window`; `resume` → `acknowledgeSevenDay`; `test on|off` → sets a session-local fake override.
- Every guard hook registered with `.catch(($, e, next) => next.called ? next(e) : { deny: 'usage-relay: its guard failed.' })`.

- [ ] **Step 2: Validate and type-check**

Run: `claude plugin validate plugin/usage-relay`
Expected: no errors. If `.claude-plugin/types/` exists, run `tsc -p plugin/usage-relay` (or the type-check command the validate output names) and expect no errors; otherwise note in the commit message that types are laid by the engine on first load.

- [ ] **Step 3: Reload in a live session**

In a new tab: `claude`, then `/reload-plugins`. Expected: status shows `5h N% · 7d N%` and `/relay status` answers. With `USAGE_RELAY_FAKE_5H=95`, the status shows 95% and a tool call is denied with the handoff reason.

- [ ] **Step 4: Commit**

```bash
git add plugin/usage-relay/hooks/register.tsx
git commit -m "feat: wire the usage relay guard

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: End-to-end verification and README

**Files:**
- Modify: `plugin/usage-relay/README.md`
- Create: `docs/e2e-checklist.md`

**Interfaces:**
- Consumes: the wired plugin.
- Produces: a verified install, documented test procedure, and uninstall that leaves no trace.

- [ ] **Step 1: Run the outbound end to end**

In a scratch git repo, start `claude --model "Claude Code API/claude-opus-5-5[1m]"` with `USAGE_RELAY_ROLE=claude` and `USAGE_RELAY_FAKE_5H=95`, and ask for a small multi-step task. Expected: first tool call denied with the handoff reason, `HANDOFF.md` written, a new terminal tab opens on `DeepSeek/deepseek-flash` running the initial prompt, and no further denials in that window.

- [ ] **Step 2: Run the return end to end**

In the DeepSeek tab, set `USAGE_RELAY_FAKE_5H=0` (or wait for a real reset). Expected: the idle session wakes itself, writes `HANDOFF.md`, and opens a Claude tab. If the wake does not happen, record it and stop; report to the person.

- [ ] **Step 3: Run the 7d case**

With `USAGE_RELAY_FAKE_7D=95`: tools denied (reads allowed), one notification, `/relay resume` unblocks, and a new weekly window re-arms.

- [ ] **Step 4: Confirm no config was touched**

Run: `git -C ~/.claude status --short 2>$null; claude plugin list | Select-String usage-relay`
Expected: `~/.claude` is not a git repo or shows no change from this work; the plugin is listed as installed and read from its folder. Uninstall with `claude plugin uninstall usage-relay` and `claude plugin marketplace remove handoff-hook`, then confirm a new session starts without the status line.

- [ ] **Step 5: Write the checklist and update the README**

`docs/e2e-checklist.md` records each step's observed result with a date. README gains: install, configure, fake-usage testing, uninstall, and "what this does not do" (old tab stays open; no auto-start when no session exists; the mod API is early access).

- [ ] **Step 6: Commit**

```bash
git add plugin/usage-relay/README.md docs/e2e-checklist.md
git commit -m "docs: end-to-end checklist and usage-relay README

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
