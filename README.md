# handoff-hook

A Claude Code mod that keeps work moving through usage limits without leaving
the terminal. You declare a preference-ordered chain of models — Claude first,
then DeepSeek, then whatever you add. When the current step runs out of room
(a 5-hour window, a prepaid balance, session spend), the session writes a
handoff and opens the next step's model in a new Windows Terminal tab. When an
earlier step becomes available again, the chain moves back.

It does nothing until you create a chain and run `/relay enable` in a session.

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
- A way to run the other models through `claude --model`: [claude-code-router][ccr]
  is what this was developed against, but any gateway that accepts a
  `provider/model` string works. The example chain uses
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
`/reload-plugins`. Create a chain at `%USERPROFILE%\.claude\usage-relay\chain.json`, then run
`/relay enable`. See [plugin/usage-relay/README.md](plugin/usage-relay/README.md)
and [METERS.md](plugin/usage-relay/METERS.md).

## How it works

- A single mod loads in every session; the DeepSeek session is just Claude
  Code on a different model, so the same code serves both directions.
- An enabled session reads its chain's meters. When the current step is
  exhausted, the owner session denies tool calls with "write HANDOFF.md and end
  your turn", then opens the next step's tab at the end of the turn.
- Meters are pluggable: Claude's OAuth usage windows, a DeepSeek balance, or
  session spend. Adding a provider is one reader plus one config entry.
- A 7-day breach blocks tools (reads allowed) and notifies; it never moves the
  chain. `/relay resume` acknowledges that weekly window.
- One session at a time moves the chain, guarded by an exclusive lock file.

## Documentation

- [Design](docs/superpowers/specs/2026-10-27-usage-relay-design.md)
- [Spike results](docs/spike-results.md) — what the environment actually does
- [Chain design](docs/superpowers/specs/2026-10-27-chain-relay-design.md)
- [End-to-end checklist](docs/e2e-checklist.md) — what was verified, and the
  checks that need a real interactive run

## Limits

Windows only. The old tab stays open. Nothing starts if no session is
running. The usage endpoint and the mod API are both early access.

## License

[MIT](LICENSE) © 2026 Rudhra Raveendran
