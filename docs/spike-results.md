# Spike results — usage relay assumptions

Date: 2026-10-27
Build: Claude Code 2.1.312, Windows 11, CCR gateway at 127.0.0.1:3456.

| Question | Verdict |
|---|---|
| Does `$.session.usage().rateLimits` carry the 5h/7d windows behind the gateway? | **No.** Empty `[]` in both a Claude-model session and a DeepSeek-model session, before and after a turn. The OAuth usage endpoint is the only working source, as the design's fallback assumed. |
| Is `$.session.measure` enough on its own? | No. It never supplies rate limits here because the underlying figures are empty. The poller must fetch. |
| Does `$.store` persist across sessions? | **Yes.** A fresh process read the value written by an earlier, exited session (`probe` → prior session id). Cross-process reads are reliable at session start and on each poll. |
| Is a store claim atomic? | **Not proven.** `$.store` offers get/set only, last-write-wins. The design's exclusive-create lock file is required for the 5h window claim rather than trusting the store alone. |
| Does `five_hour.resets_at` drift between polls? | **Yes, by ~0.3 s** (`02:29:59.894` → `02:30:00.219`). Rounding epoch-ms to the nearest minute maps both to the same key, so the window key is stable. The remaining risk is a sample landing within 0.5 s of a minute boundary; a 60 s tolerance in the key comparison (not just rounding) covers it. |
| Does a `tool.call` deny reach the model in a non-interactive run? | **Yes, verbatim.** The model received `<tool_use_error>SPIKE-DENY: bash is blocked...` and did not run the command. |
| Does `wt` launch work? | **Yes, with `-EncodedCommand`.** `wt -w 0 new-tab -d <dir> pwsh -NoExit -Command "<string with ; and |>"` silently fails to run the command (no output, exit 0). `pwsh -NoExit -EncodedCommand <base64 UTF-16LE>` works: the tab opened, the role env var was set, `claude` ran and answered. |
| Can a hook pass `$` to a local helper? | **No.** `claude plugin validate` refuses `$ is passed to "write", which is not a function declared at the top of this file`. Every `$.noun.method(...)` call must be written at the call site inside the hook body. Pure helpers may take plain values only. |
| `classic.Stop` block forcing a handoff write | Not exercised in this spike (interactive only). Left to the end-to-end run in Task 8. |

## Consequences for the build

1. Usage source: endpoint only, in both roles. `$.session.usage()` is still read for nothing; drop it from the poller to keep the tick simple.
2. Claims: exclusive-create lock file, store as the readable mirror.
3. Window key: minute-rounded epoch, with a 60 s tolerance when comparing.
4. Launcher: `-EncodedCommand` with UTF-16LE base64; the argv is a plain array with no shell metacharacters.
5. Wiring: all `$` calls inline in hook bodies; helpers stay pure.
