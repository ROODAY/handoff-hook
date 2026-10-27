# usage-relay

A Claude Code mod that keeps work moving through usage limits without leaving the
terminal. It watches the 5-hour Claude window; when it nears the cap the current
session writes `HANDOFF.md` and opens a fresh DeepSeek session in a new Windows
Terminal tab. When the Claude window resets, the DeepSeek session writes its own
handoff and opens a fresh Claude session. The old tab is left open for you to close.

## Install

```
claude plugin marketplace add C:/Users/Rudhra/Code/handoff-hook
claude plugin install usage-relay@handoff-hook --scope user
```

It is read from this folder, so edits take effect with `/reload-plugins`.

## Configure

Every field is a row in `/config` (or `claude plugin configure usage-relay`):

| Field | Default | Meaning |
|---|---|---|
| `five_hour_threshold` | 90 | % of the 5-hour window that triggers a handoff |
| `resume_below` | 5 | % the window must fall to before returning to Claude |
| `seven_day_threshold` | 90 | % of the 7-day window that blocks tool calls (no switch) |
| `poll_seconds` | 60 | polling period |
| `handoff_file` | `HANDOFF.md` | handoff file in the project root |
| `claude_model` | `Claude Code API/claude-opus-5-5[1m]` | model for the return trip |
| `deepseek_model` | `DeepSeek/deepseek-flash` | model for the outbound trip |
| `enabled` | true | master switch |

Environment overrides, read per session: `USAGE_RELAY_ROLE` (`claude` or
`deepseek`, set by the launcher), `USAGE_RELAY_5H`, `USAGE_RELAY_7D`,
`USAGE_RELAY_RESUME_BELOW`, `USAGE_RELAY_FAKE_5H`, `USAGE_RELAY_FAKE_7D`,
`USAGE_RELAY_RESET=1` (clears the plugin's saved state at session start),
`USAGE_RELAY_DISABLED=1`. With no `USAGE_RELAY_ROLE`, a session whose model
name contains `deepseek` is treated as the DeepSeek side.

## Slash command

`/relay status | now | back | pause | resume | reset | test on | test off`.

- `resume` acknowledges the current 7-day window after a tool block.
- `pause` suppresses switches for five hours; it never disables the tool gate.
- `reset` clears saved relay state on this machine.

## Testing without burning quota

Start a session with `USAGE_RELAY_FAKE_5H=95` (PowerShell:
`$env:USAGE_RELAY_FAKE_5H=95; claude`). The status reads 95% and the first tool
call is denied with the handoff instruction.

## Uninstall

```
claude plugin uninstall usage-relay
claude plugin marketplace remove handoff-hook
```

No file outside this repository and your Claude plugin config is changed.

## Limits

The old tab stays open. Nothing starts if no session is running. The mod API is
early access and may change between Claude Code releases.
