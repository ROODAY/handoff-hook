# Chain Relay: configurable fallback chain with handoffs

Date: 2026-10-27
Status: draft for approval
Supersedes the two-role model in `2026-10-27-usage-relay-design.md` (that design's
Claude meter, handoff template, gate, launcher and lock carry over).

## Intent

Let a person declare a preference-ordered chain of models — Claude first, then
DeepSeek, then whatever else they add — and have the mod keep them on the
**earliest chain step that is currently available**. A step becomes unavailable
when its own meter says so (Claude's 5h window, a provider balance, session
spend). Moving costs a written handoff: the leaving session writes
`HANDOFF.md` at the end of its turn and the arriving model starts fresh from it.
This mirrors a router fallback chain, except the trigger is a spend/usage limit
met while quota remains — not a failed request.

## What exists today (and carries over)

- One Claude Code mod, no daemon, stock `claude` binary; successors are new
  Windows Terminal tabs running `claude --model <model> "<prompt>"`.
- Claude usage from `GET api.anthropic.com/api/oauth/usage` with the OAuth token
  in `~/.claude/.credentials.json` (verified; the status line never carries
  rate limits behind this gateway).
- Handoff template and deny/reminder text; tool gate (reads allowed, handoff
  writable); `classic.Stop` block; exclusive-create claim lock; three-minute
  lease; `wt`/`preview`/path launcher; `USAGE_RELAY_RESET`, fake usage.
- Mod API constraint: `$` cannot be passed to helpers; nested config cannot
  live in `userConfig`.

## Goals

1. A `chain.json` file lists steps in preference order; each step names a model,
   a meter, and that meter's thresholds.
2. Each session knows its step from `USAGE_RELAY_STEP` (set by the launcher).
   The fallback matches the session's model against the chain tolerantly —
   case-insensitive, with a trailing context suffix such as `[1m]` ignored —
   because `$.session.model()` reported `Claude Code API/claude-opus-5-5` where
   the configured model is `...-5-5[1m]`.
3. Every poll evaluates the earliest step that is available. If that is not the
   current step, the session requests a handoff; at turn end it writes the file
   and launches the target step with `USAGE_RELAY_STEP=<target id>`.
4. Meters are a registry. v1 ships `claude-oauth`, `deepseek-balance` and
   `session-spend`; adding a provider is one inline reader + one pure parser.
5. Hysteresis: a step counts as available again only past its own
   `resume_*` threshold, so the chain does not flap at the boundary.
6. Adding a step, reordering, or using one step only are config changes, not
   code changes.

## Non-goals

- Reading or editing CCR's config, database or logs. Providers are reached by
  the mod itself, with keys the person gives it.
- A background daemon; in-session model switches; closing the old tab.
- OpenAI org usage/costs (needs an org admin key); account-level quotas for any
  provider that does not expose them.
- Token refresh.
- Changing the 7-day behaviour: it pauses tools inside the Claude step and is
  acknowledged with `/relay resume`; it never moves the chain.

## Anti-goals

- Handing off mid-turn, or to a step that is itself exhausted.
- Two sessions moving the chain at once, or two tabs launched for one move.
- Flapping between two steps at a threshold.
- Moving on a meter read that failed.
- Losing a handoff because the leaving model could not finish the turn.

## Design

### Chain file

`~/.claude/usage-relay/chain.json` by default, built from `USERPROFILE` (`$.fs`
does not expand `~`); `userConfig.chain_file` (and `USAGE_RELAY_CHAIN_FILE`)
name another path. Read at `session.start` and on
`/relay reload`. A hash of the parsed file is the `chainId`; a different
`chainId` with the same file path invalidates step-specific state.

```json
[
  {
    "id": "claude",
    "label": "Claude",
    "model": "Claude Code API/claude-opus-5-5[1m]",
    "meter": {
      "type": "claude-oauth",
      "exhaust_at": { "five_hour": 90 },
      "pause_at": { "seven_day": 90 },
      "resume_below": { "five_hour": 5 }
    }
  },
  {
    "id": "deepseek",
    "label": "DeepSeek",
    "model": "DeepSeek/deepseek-flash",
    "meter": {
      "type": "deepseek-balance",
      "api_key_env": "DEEPSEEK_API_KEY",
      "exhaust_below": { "amount": 2, "currency": "USD" },
      "resume_above": { "amount": 3, "currency": "USD" }
    }
  }
]
```

Validation, in this order: non-empty array; unique `id` (`[a-z0-9_-]+`); model
non-empty; `meter.type` in the registry; that meter's required fields present.
An invalid file is refused whole: the session runs as a guard with no chain
(no switches, tools still gated per step 1 if the first step parses? no —
refused whole means no chain and no gate) and the status line says why.

### Meters (the registry)

Each meter answers two questions and reports its own numbers for display.

```ts
type MeterReading = {
  exhausted: boolean    // this step should be left
  available: boolean    // this step may be returned to (hysteresis passed)
  gate: { kind: 'seven_day'; detail: string } | null   // stay, but block tools
  summary: string       // "5h 62% · 7d 71%", "$4.12 left"
  fetchedAt: number
  stale: boolean        // a read failed and this is the last good value (or none)
}

type MeterFields = Record<string, unknown>   // that step's `meter` object
```

`exhausted` and `available` are deliberately different questions: `exhausted`
means "leave this step", `available` means "may be preferred back to". A step in
its hysteresis band (DeepSeek at $2.50 with exhaust $2 / resume $3) is neither —
and that is fine, because the selection rule below only consults `available`
for *earlier* steps. A `gate` lets a meter say "do not leave, but stop tools":
that is how a 7-day breach pauses work without moving the chain.

`read<Type>(fields, inputs)` is pure: it takes already-gathered inputs and
returns the reading. Gathering is inline in the tick (the `$` rule), one branch
per type, deduplicated per tick (one Claude fetch, one balance fetch).

| Type | Input | exhausted | available | gate |
|---|---|---|---|---|
| `claude-oauth` | usage endpoint JSON | `five_hour` ≥ `exhaust_at.five_hour` | `five_hour` ≤ `resume_below.five_hour` **and** `seven_day` < `pause_at.seven_day` | `seven_day` ≥ `pause_at.seven_day` |
| `deepseek-balance` | `GET https://api.deepseek.com/user/balance`, `Authorization: Bearer <key>` | balance < `exhaust_below.amount` | balance ≥ `resume_above.amount` | none |
| `session-spend` | `$.session.usage().cost.usd` (current step only) | cost ≥ `exhaust_at_usd` | always true | none |

Currency: the DeepSeek reading compares only the `balance_infos` entry whose
`currency` equals the configured one; no matching entry makes the reading
`stale` with a summary naming the currencies present, so a CNY balance is never
compared to a USD threshold. `session-spend` is **ledger dollars**, the CLI's own
estimate; behind a gateway that may price an aliased model at a default rate, so
it bounds a session's spend approximately, not a provider's billing.

`session-spend` is read only for the step the session is on. For any other step
the reading is synthesized as `{ exhausted: false, available: true, stale: false,
summary: 'session spend (n/a)' }`, because a fresh session starts at $0.

Adding a provider: one inline gather branch, one pure `read<Type>`, one table
row and one test. Documented in `plugin/usage-relay/METERS.md` with the exact
shape so a contributor needs no other file.

Keys: `$.env.get` accepts only names spelled as string literals in the module,
so `api_key_env` is validated at chain load against the finite set of literal
names the build knows (`DEEPSEEK_API_KEY` in v1). Each known name has a matching
`sensitive: true` `userConfig` field (`deepseek_api_key`), used when the
environment variable is unset. An unknown `api_key_env` makes the chain
invalid, with a message naming the accepted values. Keys never come from CCR
config, are never stored in `$.store`, and never reach the status line or logs.
Adding a provider adds: a literal name, a manifest field, an inline fetch and a
pure parser — documented in `METERS.md`.

### Chain state

```ts
type ChainState = {
  chainId: string
  windowKey: string            // Claude 5h window key the state is about
  desiredStepId: string | null
  phase: 'idle' | 'handoff_pending' | 'switched'
  owner: string | null         // session id holding the pending move
  ownerSeenAt: number
  requestedAt: number | null
  fromStepId: string | null
  toStepId: string | null
  pausedUntil: number
  sevenDayAck: string | null
  notifiedSevenDay: string | null
}
```

`evaluateChain(input)` is pure and returns the next state plus actions:

```ts
type ChainInput = {
  now: number; sessionId: string; stepId: string; chainId: string
  steps: Step[]; readings: Record<string, MeterReading>
  state: ChainState; turnIdle: boolean
  handoffMtimeMs: number | null; pausedUntil: number
}
type ChainResult = {
  state: ChainState
  requestHandoff: { from: string; to: string } | null
  launch: { stepId: string } | null
  blocked: { kind: 'handoff' | 'seven_day' } | null
  notify: string | null
}
```

Order of rules:

1. No chain, disabled, or `pausedUntil > now`: no moves; the gate and the 7d pause
   still apply to the current step.
2. Selection, in this exact order:
   - If the current step's reading is `stale` → stay (a failed read never moves).
   - If the current step's reading has a `gate` → stay and return
     `blocked: { kind: gate.kind }`, using the gate's detail as the deny text.
   - If the current step is **not** `exhausted` → stay. This is the sticky rule;
     the hysteresis band never triggers a move.
   - Otherwise, look for an earlier step that is `available` and not `stale`
     (preference order, earliest first). If one exists, move **back** to it.
   - Else look for a later step that is not `exhausted` and not `stale`
     (earliest first). A later step is eligible regardless of `available`: its
     hysteresis guards returning to it, not entering it.
   - Else stay and notify once per window that every step is exhausted.
3. If the chosen step differs from the current one and this session owns the
   move (see Ownership), enter `handoff_pending` with `from`/`to`,
   `requestedAt = now`.
4. While `handoff_pending` and this session owns it: block tools except the
   handoff write; when the file is fresh and `turnIdle`, return
   `launch: { stepId: to }` and `phase: 'switched'`.
5. `switched` stays inert for the same `chainId`; a later tick that selects a
   different step starts a new move.
6. A `stale` reading is never grounds for a move in either direction.
7. 7d is a `gate`, never a move — see rule 2.
8. `requestHandoff` direction is implicit: `to` may be later (exhausted step) or
   earlier (a preferred step became available). The handoff text is the same;
   only the launched step differs.

### Ownership and locks

One `relay` key per plugin (not per project): quota is account-global, and one
successor at a time is the point. Only the owning session writes it; a session
that is not the owner re-reads the shared state every tick and stays quiet, so
a second project's session is never gated for a move it cannot make. The
trade-off is explicit: the second project waits until the window resets.

A move claims an exclusive lock file in `%TEMP%`, keyed by
`chainId + fromStepId + toStepId + windowKey`. Protocol:

1. If the lock exists, stat it. Older than the lease (three minutes) → delete
   it and try once more (a dead session's move must not wedge the window).
2. Otherwise creation failure means another session owns the move: adopt the
   store's state and stay quiet.
3. A failed launch deletes the lock, returns the state to `idle`, and notifies
   with the command to run by hand, so the next tick can retry.
4. A successful launch keeps the lock; the state and the lock together prevent
   a second tab for the same `(chainId, from, to, windowKey)`.

### Wiring

- `session.start`: read the chain file, resolve `stepId` from
  `USAGE_RELAY_STEP` (else model matching, else no chain), register `/relay`,
  first tick, then `$.clock.every(poll_seconds)`.
- Tick: gather meter inputs once per type (Claude usage, each balance
  provider once), read `$.session.usage()` for spend, stat the handoff, evaluate,
  write `usage`/`relay` to the store, render status
  (`step 1/2 Claude · 5h 62% · 7d 71% · next DeepSeek`), and act.
- `tool.call`: gate from chain state (owner of a pending move blocks; the 7d
  pause blocks reads-only) using the existing `gateTool`.
- `classic.Stop`: block once while a move is pending and the handoff is not fresh.
- `turn.complete`: ignore subagent turns; set idle and tick.
- `/relay` commands: `status`, `next` (move to the next step now), `back` (move
  to the earliest available now), `reload` (re-read the chain), `pause`,
  `resume`, `reset`, `test on|off`, `meters` (print each reading and why).
- Status line: current step and meter summary; `chain invalid` / `step not in
  chain` when applicable.

### Secrets

`api_key_env` names an environment variable; a `userConfig` field with the same
name is the fallback. Keys are never written to the store, the status line, or
logs. A missing key makes that meter `stale` (never exhausted, never
available) and the status line says which key is missing.

### Compatibility

This replaces the two-role design; version 0.2.0. `userConfig` keeps
`chain_file`, `handoff_file`, `terminal`, `poll_seconds`, `enabled`; the old
threshold fields move into the chain file and are dropped from the schema with
a migration note in the README. A missing chain file adopts a default two-step
chain written from the old defaults (Claude → DeepSeek), so existing installs
keep working.

### Edge cases

| Case | Behaviour |
|---|---|
| Chain file missing or invalid | No chain; status says why; nothing switches or gates |
| Chain edited mid-session | `chainId` differs → state resets; `/relay reload` re-reads without restart |
| Current step removed from the chain | Treat as not-in-chain: no moves, tools ungated, status says so; `/relay status` names it |
| Only one step | Guard-only: gated at its meter, no moves |
| All steps exhausted | Stay; notify once per window |
| Meter read fails | `stale` reading: never a reason to move |
| Two sessions on the same step | One owns the move via the lock; the other adopts shared state |
| Launch fails | State returns to `idle`, notification carries the command |
| Subagent turns | Ignored |
| DeepSeek balance API changes | Meter goes `stale`; status names it; chain stays put |

## Testing

- Pure: chain parse/validate (each failure mode), each meter's `read` with real
  response shapes, earliest-available selection, hysteresis, forward and
  backward moves, stale readings, single step, all exhausted, window/changed
  chain resets, lock key derivation.
- Integration (test kit): a chain file with two steps; a fake reading drives a
  move; the gate blocks; Stop blocks once.
- E2E: `USAGE_RELAY_FAKE_METERS='{"claude":{"fiveHour":95},...}'` overrides
  readings so a full move can be exercised without quota or a real balance.
- One real DeepSeek balance read, once, with the person's key, to confirm the
  response shape (the doc's shape is from the public API docs).

## Decisions taken in the conversation

- Approach A (chain file + meter registry).
- Earlier in the chain is preferred; the chain always moves to the earliest
  available step.
- v1 providers: Claude and DeepSeek; other providers are additive.
- The 7-day limit stays a pause, not a move.
- Hysteresis per step (`resume_below` / `resume_above_usd`), my call.
- Invalid chain disables the chain wholesale rather than partially, my call.
- Stale readings never cause movement, my call.
- Selection is sticky: a current step that is not exhausted is kept; earlier
  steps are eligible only when they are `available` (post-hysteresis); later
  steps are eligible when they are not exhausted. This replaces a single
  "earliest available" predicate, which skipped usable steps and moved the
  chain on a 7-day breach.
- A 7-day breach is a `gate` on the current step, never an exhaustion.
- `api_key_env` is limited to literal names the module spells; unknown names
  invalidate the chain.
- Lock protocol: stale locks are reaped after the lease; a failed launch
  releases the lock and returns the state to idle.
- One plugin-global chain state; only the owner writes it; other sessions stay
  quiet and ungated.
- DeepSeek balance compares a configured currency only, never a converted total.
- `session-spend` is ledger dollars, not provider billing; synthesized as fresh
  for any step other than the current one.
