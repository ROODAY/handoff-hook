# handoff-hook

A Claude Code mod that keeps work moving through Claude usage limits without
leaving the terminal. When the 5-hour Claude window nears its cap, the current
session writes a handoff and opens a fresh **DeepSeek** session in a new
Windows Terminal tab. When the Claude window resets, the DeepSeek session
writes its own handoff and opens a fresh **Claude** session. The old tab is
left open for you to close.

It exists because a router-level fallback only switches once Claude is fully
out — too late to write anything down, and the fallback model inherits a long
Claude transcript full of tool-call habits it handles badly. A fresh session
started from a written handoff avoids both.

## Requirements

- Windows 10/11, PowerShell 7, Windows Terminal (`wt` or `preview`)
- Claude Code 2.1.312 or newer (the mod API is early access and moves)
- A Claude subscription login (`~/.claude/.credentials.json`) — the usage
  figures come from `api.anthropic.com/api/oauth/usage`, which is undocumented
  and may change
- A way to run DeepSeek through `claude --model`: [claude-code-router][ccr] is
  what this was developed against, but any gateway that accepts a
  `provider/model` string works. The default model is
  `DeepSeek/deepseek-flash`

[ccr]: https://github.com/musistudio/claude-code-router

## Install

From GitHub:

```
claude plugin marketplace add ROODAY/handoff-hook
claude plugin install usage-relay@handoff-hook
```

Or from a local clone, add the clone's path instead of the repository name.

The plugin is read from its folder, so edits take effect with
`/reload-plugins`. Configure thresholds in `/config` (or
`claude plugin configure usage-relay@handoff-hook`); see
[plugin/usage-relay/README.md](plugin/usage-relay/README.md).

## How it works

- A single mod loads in every session; the DeepSeek session is just Claude
  Code on a different model, so the same code serves both directions.
- Every session polls the usage endpoint. At 90% of the 5-hour window the
  owner session denies tool calls with "write HANDOFF.md and end your turn",
  then opens the successor tab at the end of the turn.
- A 7-day threshold blocks tools (reads allowed) and notifies; it never
  switches. `/relay resume` acknowledges that weekly window.
- One session at a time owns a window, guarded by an exclusive lock file.

## Documentation

- [Design](docs/superpowers/specs/2026-10-27-usage-relay-design.md)
- [Spike results](docs/spike-results.md) — what the environment actually does
- [End-to-end checklist](docs/e2e-checklist.md) — what was verified, and the
  two checks that need a real interactive run

## Limits

Windows only. The old tab stays open. Nothing starts if no session is
running. The usage endpoint and the mod API are both early access.

## License

Not yet chosen.
