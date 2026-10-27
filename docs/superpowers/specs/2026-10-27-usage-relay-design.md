# Usage Relay: automatic Claude ↔ DeepSeek handoff inside Claude Code

Date: 2026-10-27
Status: draft for approval

## Intent

Keep working through usage limits without leaving the Claude Code TUI. When the
5-hour Claude window nears its cap, the running Claude session writes a handoff
and a fresh DeepSeek session continues the work. When the Claude window resets,
the DeepSeek session writes a handoff and a fresh Claude session takes over
again. The person keeps their normal interactive terminal, auto mode, and
slash commands. Nothing polls from outside the harness.

## What exists today (measured, not assumed)

- Windows 11, Claude Code 2.1.312, Node 24, PowerShell 7, Windows Terminal.
  No `jq`, no `tmux`.
- `@musistudio/claude-code-router` 3.1.3 with a SQLite config. All `claude`
  sessions route through its gateway at `127.0.0.1:3456`.
- `claude auth status` reports `authMethod: api_key_helper`. **The status line
  therefore never carries `rate_limits`** (verified by dumping real stdin from
  a live session). The handoff doc's sensor, and every tool built on it
  (`ccg`, `wakey-claude`), is inert on this machine.
- A Pro OAuth login sits in `~/.claude/.credentials.json` (`claudeAiOauth`,
  `subscriptionType: pro`).
- `GET https://api.anthropic.com/api/oauth/usage` answers 200 with that token
  and returns `five_hour.utilization`, `five_hour.resets_at`,
  `seven_day.utilization`, `seven_day.resets_at` (ISO timestamps). Observed
  live: 5h 53%, 7d 66%. Undocumented endpoint; may change without notice.
- `claude -p ... --model "DeepSeek/deepseek-flash"` runs a real DeepSeek call
  through the gateway with no config change. The provider/model string is
  `DeepSeek/deepseek-flash`; the Claude model used now is
  `Claude Code API/claude-opus-5-5[1m]` (configurable).
- This build ships a mod (function-hook plugin) API with the primitives this
  needs: `$.clock.every`, `$.http.fetch`, `$.fs.read`, `$.store`,
  `$.ui.status`, `$.ui.toast`, `$.ui.notify`, `$.session.append`,
  `$.session.usage()`, `$.process.run`, `$.session.send`, plus `tool.call`,
  `turn.complete`, `session.measure`, `session.start`, `prompt.submit` and
  `classic.Stop` events. `classic.Stop` results are `{ block: "<reason>" }`,
  with `{ preventContinuation: true, stopReason }` as the hard stop.
- `$.session.usage()` returns `rateLimits: [{ kind, percentUsed, resetsAt }]`
  from the last API response, and `session.measure` pushes the same figures.
  Whether these are populated behind the CCR gateway is unknown and is spike
  step 1; if they are, the Claude-role sessions need neither the credentials
  file nor the undocumented endpoint.
- `$.audio.play` has no player on Windows, so the bell is unavailable;
  `$.ui.notify` (with `terminal_bell` as a channel where the terminal has one)
  and `$.ui.toast` are the notification floor.
- No API to end the session or change the running session's model.

## Goals

1. Always show current Claude usage in the TUI for Claude sessions
   (`5h 53% · 7d 66% · resets 22:30`).
2. At 5h ≥ threshold (default 90%), in a **Claude** session: finish the
   current turn, have the model write `HANDOFF.md`, then open a new Windows
   Terminal tab running `claude --model DeepSeek/deepseek-flash "Read
   HANDOFF.md and continue"` in the same directory. The old window stays
   open; the person closes it.
3. In a **DeepSeek** session, poll the same endpoint. Once the Claude 5h
   window has reset (or utilization is ≤ `resume_below`), the session writes
   `HANDOFF.md` and opens a new tab running Claude. If it is idle at that
   moment, it wakes itself with `$.prompt.submit`, so the switch happens
   without the person returning.
4. At 7d ≥ threshold in a Claude session: do not switch. Deny every tool call
   with "weekly usage at N%", notify the person, and stay blocked until the
   weekly window resets or the person runs `/relay resume`. Typed prompts are
   not blocked.
5. Fire once per 5h window, never launch twice, never launch into the wrong
   directory.

## Non-goals

- Closing or replacing the old window (iterate later if wanted).
- CCR-side fallback chains; CCR is only the transport that makes
  `--model DeepSeek/...` work. Nothing here edits CCR's config.
- Refreshing the OAuth token. The poller reads the file fresh each tick;
  a stale/expiring token means "skip this poll", never a refresh.
- Usage sources other than the OAuth usage endpoint.
- Auto-starting work when no session is running. If no DeepSeek session exists
  when Claude's window resets, nothing happens; the person starts one.

## Anti-goals (failure even if it "works")

- Switching mid-turn, cutting a model off in the middle of an edit.
- Two sessions each launching a successor (duplicate tabs, duplicate spend).
- Blocking the DeepSeek session because Claude's quota is high.
- Losing quota because the guard fired too late to write anything.
- Editing global `settings.json` or CCR config.

## Approaches considered

**A. Settings hooks + external poller daemon.** A poller process writes a
state file; `PreToolUse`/`Stop` command hooks read it. Rejected: requires a
daemon outside the harness, and a second toolchain (bash/jq or Node) alongside
the mod.

**B. `relay` wrapper owning the session.** Drives `claude -p` turns in a loop
and controls stopping and switching directly. Most reliable, rejected: the
person loses the interactive TUI and auto mode they asked to keep.

**C. Poller kills the session, resumes headless to write the handoff.**
Reliable, rejected: cuts the model off mid-turn, contradicts "let it finish
the turn", and needs Windows process management.

**D. A mod inside the harness (chosen).** One plugin loaded in every session.
It polls, renders status, gates tool calls, asks for the handoff at turn end,
and launches the next tab. The same mod serves both directions because
the DeepSeek session is just Claude Code on a different model. Keeps the TUI.

Trade-off accepted: a mod can't end its own session or switch its own model,
so the successor is a new tab and the old tab lingers. The mod API is early
access and may move between CLI releases; the plugin is kept small and its
surface confined to documented primitives.

## Design

### Packaging

One plugin folder in this repo: `plugin/usage-relay/` with
`.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`,
`types/index.d.ts`, plus a `marketplace.json` so it installs from this folder
into every session (mechanism verified in spike step 0; fallback is
`CLAUDE_CODE_PLUGIN_DIRS` or `--plugin-dir` via an alias). Uninstall is
`/plugin uninstall` plus deleting the folder; no global config is rewritten.

`userConfig` (editable via `/config`):

| key | default | meaning |
|---|---|---|
| `five_hour_threshold` | 90 | % that triggers Claude → DeepSeek |
| `resume_below` | 5 | % below which Claude counts as available again |
| `seven_day_threshold` | 90 | % that pauses a Claude session |
| `poll_seconds` | 60 | polling period |
| `handoff_file` | `HANDOFF.md` | relative to the session cwd |
| `claude_model` | `Claude Code API/claude-opus-5-5[1m]` | model for the return trip |
| `deepseek_model` | `DeepSeek/deepseek-flash` | model for the outbound trip |
| `enabled` | true | master switch |

### Roles

A session's role is read from env `USAGE_RELAY_ROLE` (`claude` | `deepseek`),
set by the launcher on the new tab. Absent, role is inferred from
`$.session.model()` (contains `deepseek` → DeepSeek). Sessions with no role
(plain `claude` elsewhere) still show status but never switch.

### Poller

**Source, in order of preference:**
1. Claude-role sessions try `$.session.usage().rateLimits` (live in the hook,
   no network, no credentials). Use it when `five_hour` and `seven_day` are
   present. This is settled by spike step 1; if the gateway does not forward
   the rate-limit figures, fall through to 2.
2. Otherwise the endpoint: read `~/.claude/.credentials.json`, call
   `GET https://api.anthropic.com/api/oauth/usage`. DeepSeek-role sessions
   always use this, since their own response carries only DeepSeek's limits
   (if any).

`session.measure` also fires on every whole-point move; when it does, update
the snapshot immediately rather than waiting for the next tick.

**Tick (every `poll_seconds`, and on each `session.measure`):**
1. For source 2: no `claudeAiOauth.accessToken`, or `expiresAt` within 2
   minutes → skip, mark snapshot stale. Non-200 or unparsable → skip, keep the
   previous snapshot.
2. Write snapshot to `$.store` under `usage` (shared across sessions):
   `{ fiveHour, fiveHourResetsAt, sevenDay, sevenDayResetsAt, fetchedAt,
   source }`.
3. Update `$.ui.status`: `5h 53% · 7d 66% · reset 22:30`.
4. Evaluate the state machine (below).

The token never leaves the hook, is never logged, and never enters `$.store`.
`resetsAt` is normalised to epoch seconds; the window key is
`five_hour:` + that value. If the value drifts between polls by less than 60s,
round to the nearest minute before keying so the key does not churn.

### State machine (per Claude 5h window, keyed by `fiveHourResetsAt`)

Stored in `$.store` under `relay`:

```
{ windowKey, phase, ownerSessionId, ownerHeartbeatAt, requestedAt,
  switchedAt, pausedUntil, sevenDayAckWindow }
```

- `idle` → `handoff_pending`: a Claude-role session sees 5h ≥ threshold and
  `windowKey` is new. It claims the window (`ownerSessionId = $.session.id()`,
  `ownerHeartbeatAt = now`) and refreshes the heartbeat on every poll.
- A claim is taken over when `ownerSessionId` names no live session (the
  owner's tab was closed or its launch failed) after a 10-minute lease, so a
  session cannot be stranded by a dead owner.
- `handoff_pending` → `switched`: `HANDOFF.md` exists and is newer than
  `requestedAt`, the turn has ended, and the tab was launched.
- `switched` → `idle`: `windowKey` changes (reset).
- Return trip: in a DeepSeek-role session, once the Claude window is usable
  (`fiveHour <= resume_below` and `fetchedAt >= fiveHourResetsAt`, or a new
  `windowKey` with a reading), the DeepSeek session claims `return_pending`
  and, at turn end with a fresh handoff, launches Claude and sets `returned`.
- `pausedUntil` set by `/relay pause` suppresses actions until it passes.
- `sevenDayAckWindow` holds the `seven_day` window key the person
  acknowledged with `/relay resume`. The 7d pause is active while
  `sevenDay >= seven_day_threshold` and `sevenDayKey !== sevenDayAckWindow`.
  A new weekly window re-arms the guard automatically.

**Claim safety.** `$.store` exposes only get/set/delete/keys, with no
compare-and-set and no documented cross-process semantics. Spike step 1 tests
whether two live sessions see each other's writes promptly. If they do not,
claims go through an exclusive-create marker file
(`<store dir>/locks/<windowKey>.json`, created with `fs` exclusive write or a
`pwsh -NoProfile -Command` `New-Item`/`[IO.File]::CreateNew` via
`$.process.run`), with the store as the readable mirror. Duplicate launch is
prevented by the claim plus a `switched` check immediately before
`$.process.run`, never by the phase alone.

### Enforcement (Claude role only)

Gating applies only to the session that owns the window (or a session that has
taken over an expired lease). A non-owner Claude session over the threshold
display the snapshot and a toast, and is never gated: it has no handoff of its
own to write.

- `tool.call`: if `phase` is `handoff_pending` and this session owns it, deny
  with a reason that tells the model exactly what to do:
  - "Usage is at N% of the 5-hour cap. Stop the current task. Write
    `<project root>/<handoff_file>` using the template below, then end your
    turn. Write plain markdown: no tool-call syntax, no XML tags, no
    references to conversation the reader cannot see."
  - Exceptions allowed while pending: `Read`, `Glob`, `Grep` (so the handoff
    can be accurate) and `Write`/`Edit` whose path ends in `handoff_file`.
    Everything else denied with a one-line reminder.
- Weekly cap (Claude role, any session, owner or not): while
  `sevenDay >= seven_day_threshold` and the window is not acknowledged, deny
  every tool call with "Weekly usage is at N% of the 7-day cap. Work paused;
  tell the person to run /relay resume or wait for the reset." Allowed:
  nothing except `Read`, `Glob`, `Grep` so the model can explain where things
  stand. No handoff, no switch. Typed prompts still run. Notification on the
  first denial.
- `classic.Stop`: when `handoff_pending`, the file was not written after
  `requestedAt`, and `stop_hook_active` is false → `{ block: "Write
  <handoff_file> now, using the template in the reminder above." }`. Once
  only.
- `turn.complete`: when the turn ended (`reason: 'answer'`), phase is
  `handoff_pending`, and the file exists → launch, set `switched`, notify
  "Claude at N% — DeepSeek session started". If the turn ends with no file
  and the Stop block already fired, the launcher tab is opened with the
  fallback prompt below (my call).

### The return trip (DeepSeek role)

Same poller and state machine, opposite trigger. DeepSeek sessions are never
gated: they have no Claude quota to protect.

When the Claude window becomes usable (`fiveHour <= resume_below` and reset
passed, or a new `windowKey` with a reading) and no return is in flight, the
DeepSeek session claims `return_pending` and:
1. If a turn is running, wait for `turn.complete` (`reason: 'answer'`) so the
   model finishes what it started.
2. If the session is idle, `$.prompt.submit` a short instruction: "Claude's
   5-hour window has reset. Write HANDOFF.md in the project root using the
   template, then end your turn." That starts the turn the person would
   otherwise have to type.
3. At `turn.complete` with `HANDOFF.md` newer than the request, launch a
   Claude tab (`USAGE_RELAY_ROLE=claude`) and set `returned`.

The new Claude tab picks up the handoff and continues. If the file is still
missing after the Stop block has fired once, the Claude tab opens with the
fallback prompt: "Read the transcript at <path>, write HANDOFF.md from it,
then continue."

### Directory

Everything is pinned to `$.session.root()` (the project directory the session
was started in), not `$.session.cwd()`: the handoff path is
`<root>/<handoff_file>`, and the new tab opens with `-d <root>`. `cwd` can move
mid-session (a worktree move, `/cd`) and a monorepo subdirectory makes the
three disagree, so the root is the one stable answer. No git-root resolution:
a non-git directory must work too.

### Launcher

`$.process.run` with an argv (no shell quoting):

```
wt -w 0 new-tab -d <root> pwsh -NoExit -Command <command>
```

where `<command>` sets `USAGE_RELAY_ROLE` and runs
`claude --model <target_model> "<initial_prompt>"`.
`initial_prompt` = `Read HANDOFF.md in this directory and continue the work it
describes.` A 10s timeout on `$.process.run` (the tab returns after spawning).
Failure → `$.ui.notify` with the exact command to run by hand.

### Slash command `/relay`

Registered as a command with a name and `argumentHint`; `e.args` is parsed by
the module. Subcommands: `status`, `now`, `back`, `pause`, `resume`, `test
on|off`.

### Handoff template (injected into the deny/block reason)

```
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

### Edge cases

| Case | Behaviour |
|---|---|
| Credentials missing/expired | Skip poll, keep last snapshot, status shows `usage stale` |
| Endpoint error | Skip poll, no action |
| `rateLimits` empty behind the gateway | Fall back to the endpoint (spike step 1 decides which is primary) |
| `resets_at` in the past | Window considered reset; allow return |
| `resets_at` drifts across polls | Rounded to the nearest minute before keying; a move over 60s counts as a new window |
| Two Claude sessions over threshold | Store/lock claim: first claimant owns the window; the others display status, never gated |
| Owner's tab closed or launch failed | Lease expires after 10 minutes; another session may take over |
| Duplicate launch | Claim plus `switched` re-check immediately before `$.process.run` |
| Subagent turn ends | Only main-session `turn.complete` acts (agentId absent) |
| DeepSeek session | Never gated, never triggered by Claude's 5h |
| 7d over threshold | Deny tools (reads allowed), notify once, no switch; `/relay resume` acknowledges this weekly window; a new window re-arms |
| Auto mode | Hooks fire in every permission mode; deny is respected |
| Plugin reload | State lives in `$.store`, not module variables |

## What's left to the builder

- Exact plugin install mechanism for "load in every session" (spike step 0).
- Whether `wt -w 0 new-tab ... pwsh -NoExit -Command` reliably starts an
  interactive Claude with a prompt; and whether `claude "<prompt>"` starts
  interactive (vs `-p`). Verify before wiring.
- Colour/progress rendering in `$.ui.status` (plain text is acceptable).
- Windows notification: `$.ui.notify` + `$.ui.toast`; a PowerShell toast is
  optional.
- Test file layout (`*.test.ts` beside the module) and fixtures.

## Spike before building (throwaway, in `scratch/`)

0. Load a trivial mod in **two** sessions (one Claude, one DeepSeek) and
   confirm it loads the same way in each. This settles installation.
1. Usage source: does `$.session.usage()` carry `five_hour`/`seven_day`
   behind the CCR gateway, and does `session.measure` fire? Is `resets_at`
   stable across polls? If absent, confirm the endpoint path in the hook
   (`$.fs.read` + `$.http.fetch`).
2. Store semantics: two live sessions, one writes a key, does the other read
   it on its next poll? Does a claim hold? If not, exclusive-create lock.
3. `$.ui.status` shows a live line in the TUI; `$.ui.notify` produces a
   Windows notification.
4. `tool.call` deny shows the reason to the model in auto mode.
5. `$.process.run` opens a `wt` tab that starts `claude` with a prompt.
6. `classic.Stop` `{ block }` forces a handoff write once, then releases.

## Testing (required before done)

- `claude plugin validate` clean; `tsc -p` clean; `claude plugin test` for the
  pure state machine: threshold crossing, stale token, missing fields,
  duplicate launch prevented, window rollover, resume direction, 7d pause.
- End-to-end in a scratch repo with `USAGE_RELAY_FAKE_5H=95`: tool call denied
  → HANDOFF.md written → tab opens on DeepSeek → guard silent for the rest of
  that window. Then fake a reset → the idle DeepSeek session wakes itself,
  writes a handoff → Claude tab opens. Also: fake 7d 95% denies tools, allows
  reads, survives `/relay resume`, and re-arms on the next weekly window.
- Confirm no change to `~/.claude/settings.json` or CCR config after install
  and uninstall.

## Decisions taken in the conversation

- Only the 5-hour window triggers a switch; the 7-day window pauses tools and
  notifies.
- Let the model finish its current turn before handing off.
- The old window stays open; the successor opens in a new Windows Terminal
  tab, and the person closes the old one.
- Notification floor is `$.ui.notify` + `$.ui.toast`; the Windows bell does
  not exist. A PowerShell toast is optional.
- Fallback when the model still has not written the handoff after one Stop
  block: the target tab opens with "read the transcript, write the handoff,
  then continue" (my call).
- Directory is pinned to `$.session.root()` (my call).
- Claims use an exclusive lock file if `$.store` turns out not to be live
  across processes (my call, settled by spike step 2).
