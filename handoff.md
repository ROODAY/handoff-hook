# Handoff: build a usage-threshold guard that hands off from Claude to DeepSeek

You are picking up a task to investigate and then build a small Claude Code add-on. Read this whole file before doing anything. Investigate first (Phase 1), report findings, then build (Phase 2). Ask the user before any step that modifies global config in a way that can't be trivially reverted.

---

## 1. Goal

When I'm running Claude Code (often in auto mode) on my Claude subscription, I want:

1. **Detection**: when the 5-hour usage window (and optionally the 7-day window) crosses a configurable threshold (default **90%**), detect it automatically.
2. **Stop + handoff**: interrupt the current work _while Claude still has quota_, and make Claude write a handoff file (`HANDOFF.md`) describing the state of the work so a _different model_ can continue.
3. **Switch**: start a fresh session using **DeepSeek via claude-code-router (CCR)**, with the prompt "Read HANDOFF.md and continue", so work resumes with no manual action.
4. **Fallback**: if automatic switching isn't possible or fails, at least stop, write the handoff, and alert me loudly (terminal bell + desktop notification if available) with the exact command to run.

### Why not just CCR's fallback?

I already tried CCR with DeepSeek as a fallback. It only switches when Claude _fully_ runs out. At that point Claude can't write a handoff, and DeepSeek inherits a long Claude transcript with Claude-specific tool-call/JSON habits it handles badly. A **fresh DeepSeek session started from a clean handoff** is the point of this project.

---

## 2. Known facts (verified by web research, Oct 2026)

- **Usage data source**: Claude Code pipes JSON to the custom `statusLine` command on stdin. Since v2.1.80 it includes:
  ```json
  "rate_limits": {
    "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
    "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
  }
  ```
  `resets_at` is epoch seconds. Each window can be absent (e.g. before the first API response), so handle missing fields.
- **Only on subscription (OAuth) logins.** API-key logins never populate `rate_limits`. This matters for CCR, see Phase 1.
- **Hooks do not receive `rate_limits`.** The standard pattern is: status line script acts as a sensor and writes a flag/state file; hooks read that file.
- **Known bug**: `five_hour.used_percentage` can differ between concurrently open terminals (GitHub issue, Jul 2026). Treat the value as approximate; leave margin.
- **Hook mechanics** (verify against current docs at https://docs.claude.com/en/docs/claude-code/hooks before relying on these):
  - `PreToolUse` can deny a tool call by printing
    `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`.
    The reason is shown to Claude. This works in auto mode too.
  - `Stop` hook gets `stop_hook_active`; it can print `{"decision":"block","reason":"..."}` to force Claude to continue. Always check `stop_hook_active` to avoid infinite loops.
  - Hooks are configured in `~/.claude/settings.json` (global) or `.claude/settings.json` (project).

### Existing tools to evaluate before building from scratch

- **claude-cache-guard (`ccg`)**: `npm install -g claude-cache-guard && ccg install`, repo `yuliang615/claude-cache-guard`. At a configurable 5-hour threshold (default 90) it asks Claude to write a handoff (`~/.claude/next-session/<project-id>/next_session.md`) and stops the goal. Has `ccg check-threshold --five-hour N --json` with script-friendly exit codes. Writes `~/.claude/usage-state.json`. Uses `Stop` + `PostToolBatch` hooks and patches `statusLine`. **Probably the best base**: we may only need to add the "launch DeepSeek" step.
- **wakey-claude** (`npx wakey-claude install`, repo `MaxMoffa/wakey-claude`): status line writes `~/.claude/wakey-flag.json` at a threshold (default 95, `USAGE_GUARD_THRESHOLD`); a `PreToolUse` hook blocks once and tells Claude to write `PROGRESS.md` and stop. Designed to resume on Claude after the reset, not to switch models. Small; good reference for the sensor + PreToolUse pattern.
- Not suitable: `cc-limit-guard` (just sleeps until reset); `codex-mode` (hands off to Codex, archived May 2026).

---

## 3. Phase 1: investigation (do this first, then report)

Report findings to me in a short summary before building. Specifically:

1. **Environment**: OS, shell, Claude Code version (`claude --version`), CCR version (`ccr -v` or equivalent), whether `jq`, `tmux`, `notify-send`/`osascript` are available.
2. **How I currently run things**: read `~/.claude-code-router/config.json` (redact API keys in anything you print). Identify:
   - How Claude (Anthropic) traffic is routed. Is it going through CCR with an API key, or with my subscription/OAuth, or am I running plain `claude` for Claude work?
   - The DeepSeek provider name and model string, as used in CCR's `Router` config (`"provider,model"` format).
3. **Critical check: does the status line receive `rate_limits` in my actual setup?**
   - Temporarily set a status line command that dumps stdin to a file (e.g. `tee ~/.claude/statusline-debug.json`), run one prompt, and inspect it. Do this both under plain `claude` and under `ccr code` if I use both.
   - If `rate_limits` is missing under CCR, the plan becomes: run Claude work with plain `claude` (subscription), and use CCR only for the DeepSeek session. Tell me if that's the case.
4. **Existing config**: read `~/.claude/settings.json`. Note any existing `statusLine` and hooks. **We must not clobber them**: an existing status line must be wrapped/chained, not replaced.
5. **How to launch a DeepSeek session without editing global CCR config.** Find out (CCR README / `ccr --help` / source) whether CCR supports any of:
   - a per-invocation config file or env var,
   - presets/profiles,
   - choosing the model at launch time,
   - the in-session `/model provider,model` command (could be sent as the first message).
     If none exist, propose the least invasive option (e.g. a second CCR config dir + env var, or temporarily swapping `Router.default` and restoring it).
6. **Evaluate `ccg`**: install it in a test or look at its source, and decide whether to build on it (add the switch step) or write our own minimal version. Recommend one, with reasons.

---

## 4. Phase 2: build

Build whichever approach Phase 1 supports. Reference design for building our own:

### Components (put everything in `~/.claude/usage-guard/`)

1. **`config.json`**

   ```json
   {
     "five_hour_threshold": 90,
     "seven_day_threshold": null,
     "handoff_file": "HANDOFF.md",
     "on_threshold": "handoff_and_switch",
     "switch": {
       "launcher": "tmux",
       "command": "ccr code",
       "deepseek_model": "<provider,model from Phase 1>",
       "initial_prompt": "Read HANDOFF.md in this directory and continue the work it describes."
     },
     "state_max_age_seconds": 900
   }
   ```

   `on_threshold` options: `handoff_and_switch` | `handoff_only` | `warn_only`. Thresholds should also be overridable by env var (e.g. `USAGE_GUARD_5H=85`).

2. **Status line sensor `statusline.sh`**
   - Reads stdin JSON; writes `~/.claude/usage-guard/state.json` with `five_hour`, `seven_day`, `session_id`, `cwd`, `updated_at`.
   - Chains to the user's previous status line command (if any) by passing the same stdin through, so display stays the same. Optionally append `5h:NN%`.
   - Must be fast and never fail visibly (exit 0, handle missing fields).

3. **`PreToolUse` hook `pretooluse.sh`**
   - If state is fresh and over threshold, and this window hasn't been handled yet (key on `resets_at`), **deny** the tool call once with a reason telling Claude to:
     - stop the current task immediately,
     - write `HANDOFF.md` in the project root using the template below,
     - do nothing else after writing it, and end its turn.
   - Allow the `Write`/`Edit` tool calls that create `HANDOFF.md` itself (otherwise Claude can't write it). Simplest approach: after the first deny, mark state `handoff_requested`, and allow all subsequent tool calls whose target file is `HANDOFF.md`. Deny other tool calls with a short reminder.
   - Record handled state in `~/.claude/usage-guard/handled.json` so it fires **once per window per project**.

4. **`Stop` hook `stop.sh`**
   - If `handoff_requested` and `HANDOFF.md` does not exist (or wasn't updated after the request) and `stop_hook_active` is false: block once with "Write HANDOFF.md before stopping."
   - If `HANDOFF.md` exists and `on_threshold == handoff_and_switch`: launch the DeepSeek session **detached** (e.g. `tmux new-window -c "$cwd" '<ccr command> "<initial_prompt>"'`; if not inside tmux, `tmux new-session -d` and tell the user how to attach). Then notify the user (bell + desktop notification).
   - Never block forever; never launch twice for the same window (lock file).

5. **`install.sh` / `uninstall.sh`**
   - Back up `~/.claude/settings.json` to a timestamped file before editing.
   - Merge hooks into settings with `jq` (don't overwrite existing hooks arrays; append ours).
   - Uninstall restores the previous `statusLine` and removes only our hooks.

### HANDOFF.md template (Claude writes this; DeepSeek reads it)

Keep it model-neutral and explicit. DeepSeek should not need any Claude-specific context.

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

Include in the hook's deny reason: "Write plain markdown. No tool-call syntax, no XML tags, no references to earlier conversation that the reader can't see."

### Edge cases to handle

- `rate_limits` absent → do nothing.
- Stale state file (older than `state_max_age_seconds`) → do nothing.
- Multiple concurrent sessions in different projects → each project hands off independently; don't launch DeepSeek in the wrong directory (use the hook's `cwd`).
- Subagents: a `SubagentStop` shouldn't trigger the switch.
- The guard must not fire inside the DeepSeek session itself (no `rate_limits` there, but also set an env var like `USAGE_GUARD_DISABLED=1` in the launch command).
- Window reset: once `resets_at` passes, clear handled state.

---

## 5. Testing (required before calling it done)

- Unit-test the scripts by piping fake JSON (thresholds below/above, missing fields, stale timestamps).
- Add a **test mode**: `USAGE_GUARD_FAKE_5H=95` makes the sensor pretend usage is 95%, so the whole flow can be exercised end to end without burning quota.
- End-to-end run in a scratch git repo: start a small multi-step task in auto mode with fake 95%, and confirm:
  1. the tool call is denied once,
  2. Claude writes `HANDOFF.md` and stops,
  3. a tmux window opens running DeepSeek via CCR with the initial prompt,
  4. the guard doesn't fire again in the same window,
  5. uninstall restores `settings.json` exactly (diff against backup).

---

## 6. Constraints

- Bash + `jq` preferred (Node acceptable if CCR/ccg already require it). No heavy dependencies.
- Never print or commit API keys from the CCR config.
- Back up anything you edit outside the project directory; tell me what you changed and where the backups are.
- If the docs contradict anything in section 2, trust the current docs and tell me.

## 7. Deliverables

1. Phase 1 findings summary (short) and your recommendation (extend `ccg` vs build our own). **Wait for my OK.**
2. The working guard + install/uninstall scripts.
3. A short README: how to install, configure the threshold, test with fake usage, and uninstall.
