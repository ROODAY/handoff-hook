# usage-relay end-to-end checklist

Run 2026-10-27 on Windows 11, Claude Code 2.1.312, scratch directory
`scratch/e2e` (gitignored). Fake usage stands in for the real windows.

| # | Case | Command | Observed |
|---|---|---|---|
| 1 | Outbound switch | `USAGE_RELAY_ROLE=claude USAGE_RELAY_FAKE_5H=95 USAGE_RELAY_RESET=1 claude -p --permission-mode acceptEdits "Run the bash command 'echo hi'..."` | Bash denied; model wrote `HANDOFF.md` in the project root; a new Windows Terminal tab opened running `claude --model DeepSeek/deepseek-flash "Read HANDOFF.md..."` |
| 2 | 7-day pause | `USAGE_RELAY_ROLE=claude USAGE_RELAY_FAKE_7D=95 USAGE_RELAY_RESET=1 claude -p "Read package.json, then run 'echo hi'..."` | Read allowed; Bash denied with the 7-day message naming `/relay resume`; no switch |
| 3 | Return instruction | `USAGE_RELAY_ROLE=deepseek USAGE_RELAY_FAKE_5H=1 USAGE_RELAY_RESET=1 claude -p --model DeepSeek/deepseek-flash "Reply OK."` | DeepSeek received the handoff request in-turn; the write was blocked by headless permissions, so no launch (correct) |
| 4 | `/relay status` in `-p` | `claude -p "/relay status"` | Not dispatched: plugin slash commands need an interactive session. Verify `/relay status`, `/relay now`, `/relay resume` in a real tab. |
| 5 | Uninstall | `claude plugin uninstall usage-relay` / `claude plugin marketplace remove handoff-hook` | Pending a real uninstall run; no file outside the repo and the plugin config is touched by install. |

## Notes

- `--permission-mode acceptEdits` is required headlessly only so the model can
  write `HANDOFF.md`; the guard's own gate is independent of permission mode.
- `USAGE_RELAY_RESET=1` clears the plugin's store at session start. The store
  is per plugin, so nothing external can clear it.
- A launched test session was left running when process termination was
  refused by the harness; close its tab manually.
- The full return trip (handoff written, Claude tab opened) still needs one
  interactive run with the person present, because an unattended launched
  Claude session would start working immediately.
