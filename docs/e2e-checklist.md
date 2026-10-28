# End-to-end checklist

Runs on 2026-10-27, Windows 11, Claude Code 2.1.312. Scratch directories are
gitignored.

## Chain relay (0.2.0)

| # | Case | Command | Observed |
|---|---|---|---|
| 1 | Forward move | `USAGE_RELAY_ENABLED=1 USAGE_RELAY_RESET=1 USAGE_RELAY_STEP=claude USAGE_RELAY_CHAIN_FILE=<scratch>/chain.json USAGE_RELAY_FAKE_METERS='{"claude":{"exhausted":true,"available":false},"deepseek":{"exhausted":false,"available":true}}' claude -p --permission-mode acceptEdits "Run bash echo hi."` | Bash denied with the handoff text; `HANDOFF.md` written; lock file created; a new tab ran `claude --model Fake/two` (the placeholder step model), so no real agent worked |
| 2 | Return move | `USAGE_RELAY_ENABLED=1 USAGE_RELAY_RESET=1 USAGE_RELAY_STEP=deepseek ... USAGE_RELAY_FAKE_METERS='{"claude":{"exhausted":false,"available":true},"deepseek":{"exhausted":false,"available":false}}' claude -p --model Fake/two ...` | Return requested, `HANDOFF.md` written, `deepseek-claude` lock created and the Claude-side tab launched |
| 3 | Disabled by default | integration test `a disabled session does nothing and allows tools` | Status `usage-relay: disabled`; tools allowed |
| 4 | Enable with no chain | integration test `enabling with no chain is refused` | "No chain configured. Set chain_file in /config or create …"; stays disabled |
| 5 | Real chain installed | `%USERPROFILE%\.claude\usage-relay\chain.json` copied from `chain.example.json` | A probe session starts, reads it and answers normally |
| 6 | Real DeepSeek balance read | needs `DEEPSEEK_API_KEY` | **Not run** — no key was set. `/relay meters` should show a dollar summary once it is |
| 7 | Interactive `/relay` commands | `/relay status`, `enable`, `meters` in a real tab | **Not run headlessly** (plugin slash commands are not dispatched in `-p`) |
| 8 | Uninstall | `claude plugin uninstall usage-relay` | **Not run** in this round |

## Notes

- The test runs used placeholder model names (`Fake/one`, `Fake/two`) so a
  launched tab could not begin working on the repository.
- The claim lock lives at `%USERPROFILE%\.claude\usage-relay\lock-<key>.lock`;
  a lock older than three minutes is deleted and recreated.
- `[IO.File]::CreateNew` does not exist in this PowerShell's runtime; the lock
  uses `[IO.File]::Open(path, [IO.FileMode]::CreateNew)`, which is atomic.
- `USAGE_RELAY_RESET=1` is needed between test runs because the chain state is
  deliberately shared across sessions.

## Earlier two-role runs (0.1, superseded)

The outbound switch, 7-day pause and return instruction were verified under the
previous architecture; the chain rewrite keeps the same handoff, gate, Stop hook
and launcher.
