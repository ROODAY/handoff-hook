# Meters

A chain step becomes "unavailable" through its meter. Every meter answers the
same two questions and reports its own numbers, which is what lets a percentage
window and a dollar balance sit in one preference list.

## The contract

`readMeter(step, inputs, now)` is pure; the hook gathers the inputs inline and
passes them in.

```ts
type MeterReading = {
  exhausted: boolean   // leave this step
  available: boolean   // may be returned to (hysteresis passed)
  gate: { kind: 'seven_day'; detail: string } | null  // stay, but block tools
  summary: string      // "5h 62% · 7d 71%", "$4.12 left"
  fetchedAt: number
  stale: boolean       // the read failed or a prerequisite is missing
  fiveHourKey: string  // window keys, '' when the meter has none
  sevenDayKey: string
}
```

Rules that hold for every meter:

- `exhausted` and `available` are different questions. A step in its hysteresis
  band is neither, and the chain stays on it.
- A `stale` reading never causes a move in either direction. If it is the
  current step's reading, the session stays put; if it is an earlier step's, it
  is not eligible.
- `gate` blocks the current session's tools without moving the chain.

## v1 meters

### `claude-oauth`

```json
{ "type": "claude-oauth", "exhaust_at": { "five_hour": 90 },
  "pause_at": { "seven_day": 90 }, "resume_below": { "five_hour": 5 } }
```

Reads `GET https://api.anthropic.com/api/oauth/usage` with the OAuth token from
`~/.claude/.credentials.json` (never refreshed; an expired token makes the
reading stale). Exhausted when `five_hour.utilization >= exhaust_at.five_hour`.
Gates when `seven_day.utilization >= pause_at.seven_day`. Available when
`five_hour.utilization <= resume_below.five_hour` and it is not gated.

### `deepseek-balance`

```json
{ "type": "deepseek-balance", "api_key_env": "DEEPSEEK_API_KEY",
  "exhaust_below": { "amount": 2, "currency": "USD" },
  "resume_above": { "amount": 3, "currency": "USD" } }
```

Reads `GET https://api.deepseek.com/user/balance`, compares only the
`balance_infos` entry whose `currency` matches `exhaust_below.currency`.
`resume_above` defaults to `exhaust_below.amount + 1`. A missing key or currency
makes the reading stale, and the summary names what is missing.

### `session-spend`

```json
{ "type": "session-spend", "exhaust_at_usd": 2 }
```

Uses `$.session.usage().cost.usd` — the CLI's ledger estimate, not provider
billing. It is read only for the step the session is on; for any other step the
reading is synthesized as fresh. Exhausted when the cost reaches the limit.

## Adding a provider

1. Add its environment variable name to `KNOWN_API_KEY_ENVS` in `chain.ts`, and a
   matching `sensitive: true` field to `plugin.json`.
2. Add an inline fetch in `register.tsx`'s tick (the `$` rule forbids helpers)
   that puts the raw response into `inputs.balances[<env>]`.
3. Add a pure reader in `meters.ts` returning the `MeterReading` above, and a
   case in `readMeter`.
4. Add tests in `meters.test.ts` for exhaustion, the hysteresis band, a stale
   read, and the summary text.

A provider that only exposes a balance needs no state changes beyond that; one
that exposes a percentage window can borrow `claude-oauth`'s shape.
