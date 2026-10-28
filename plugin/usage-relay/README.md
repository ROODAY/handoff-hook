# usage-relay

A Claude Code mod that moves work along a preference-ordered chain of models
when a step runs out of room, writing `HANDOFF.md` at every move so the next
session starts clean. Claude first, then DeepSeek (or whatever you add), and
back to Claude when its window resets.

**It does nothing until you enable it.** A session starts disabled; `/relay
enable` turns it on for that session, and sessions it launches inherit the
setting.

## Install

```
claude plugin marketplace add ROODAY/handoff-hook
claude plugin install usage-relay@handoff-hook
```

The plugin is read from its folder; `/reload-plugins` picks up edits.

## The chain

There is **no default chain**. Without a readable chain file the relay never
gates or moves. Create one at
`%USERPROFILE%\.claude\usage-relay\chain.json` (or point `chain_file` at it):

```json
[
  { "id": "claude", "label": "Claude",
    "model": "Claude Code API/claude-opus-5-5[1m]",
    "meter": { "type": "claude-oauth",
               "exhaust_at": { "five_hour": 90 },
               "pause_at": { "seven_day": 90 },
               "resume_below": { "five_hour": 5 } } },
  { "id": "deepseek", "label": "DeepSeek",
    "model": "DeepSeek/deepseek-flash",
    "meter": { "type": "deepseek-balance",
               "api_key_env": "DEEPSEEK_API_KEY",
               "exhaust_below": { "amount": 2, "currency": "USD" },
               "resume_above": { "amount": 3, "currency": "USD" } } }
]
```

Steps are tried in order. Each session knows its step from `USAGE_RELAY_STEP`
(set by the launcher) or, failing that, its model name. The chain always moves
to the earliest available step: forward when the current step is exhausted,
back when an earlier one becomes available. See [chain.example.json](chain.example.json)
and [METERS.md](METERS.md).

## Enable and control

| Command | What it does |
|---|---|
| `/relay enable` | Turns the relay on for this session; refuses if there is no valid chain |
| `/relay disable` | Turns it off for this session |
| `/relay status` | Enabled state, chain, step, phase, usage |
| `/relay meters` | Every step's reading and why it is exhausted/available/stale |
| `/relay next` / `back` | Move to the next step / the earliest available one at turn end |
| `/relay reload` | Re-read the chain file |
| `/relay pause` | No moves for five hours (the tool gate still applies) |
| `/relay resume` | Acknowledge the current 7-day window after a block |
| `/relay reset` | Clear the relay's saved state on this machine, including the usage backoff |

`/config` holds the settings: `chain_file`, `handoff_file`, `terminal`
(`wt`, `preview`, or a path), `poll_seconds`, `enabled` (start enabled), and a
secure `deepseek_api_key` used when `DEEPSEEK_API_KEY` is not set.

Environment overrides: `USAGE_RELAY_ENABLED`, `USAGE_RELAY_STEP`,
`USAGE_RELAY_CHAIN_FILE`, `USAGE_RELAY_TERMINAL`, `USAGE_RELAY_HANDOFF`,
`USAGE_RELAY_POLL`, `USAGE_RELAY_FAKE_METERS`, `USAGE_RELAY_RESET`,
`USAGE_RELAY_DISABLED`.

## Testing without quota

`USAGE_RELAY_FAKE_METERS='{"claude":{"exhausted":true},"deepseek":{"exhausted":false}}'`
with `USAGE_RELAY_ENABLED=1` forces the readings, so a full move can be
exercised without spending anything.

## Upgrading from 0.1

The threshold fields moved out of `/config` into the chain file. Create a chain
(the example above is the old behaviour), then `/relay enable`. Nothing runs
until you do.

## Limits

Windows only. The old terminal tab stays open. Nothing starts if no session is
running. The Claude usage endpoint and the mod API are both early access.
