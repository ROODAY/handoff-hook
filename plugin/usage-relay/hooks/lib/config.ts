import type { PluginOptions } from 'claude-code'

export type FakeMeter = { exhausted?: boolean; available?: boolean }

export type Config = {
  chainFile: string
  handoffFile: string
  pollSeconds: number
  terminal: string
  enabled: boolean
  deepseekApiKey: string | null
  fakeMeters: Record<string, FakeMeter> | null
  reset: boolean
}

const DEFAULTS = {
  handoffFile: 'HANDOFF.md',
  pollSeconds: 60,
  terminal: 'wt',
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function fakeMeters(value: string | undefined): Record<string, FakeMeter> | null {
  if (value === undefined || value.length === 0) return null
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, FakeMeter>)
      : null
  } catch {
    return null
  }
}

export function readConfig(
  options: PluginOptions,
  env: Record<string, string | undefined>,
): Config {
  const o = options as Record<string, unknown>
  const pick = <T>(name: string, fallback: T): T => {
    if (o[name] !== undefined && o[name] !== null) return o[name] as T
    return fallback
  }
  const home = env.USERPROFILE ?? ''
  const defaultChain = `${home}\\.claude\\usage-relay\\chain.json`

  return {
    chainFile: str(env.USAGE_RELAY_CHAIN_FILE, str(pick('chain_file', ''), defaultChain)),
    handoffFile: str(
      env.USAGE_RELAY_HANDOFF,
      str(pick('handoff_file', DEFAULTS.handoffFile), DEFAULTS.handoffFile),
    ),
    pollSeconds: Math.max(
      5,
      num(env.USAGE_RELAY_POLL, num(pick('poll_seconds', DEFAULTS.pollSeconds), DEFAULTS.pollSeconds)),
    ),
    terminal: str(env.USAGE_RELAY_TERMINAL, str(pick('terminal', DEFAULTS.terminal), DEFAULTS.terminal)),
    enabled:
      env.USAGE_RELAY_ENABLED === '1' ||
      (env.USAGE_RELAY_ENABLED !== '0' &&
        pick('enabled', false) === true &&
        env.USAGE_RELAY_DISABLED !== '1'),
    deepseekApiKey: str(env.DEEPSEEK_API_KEY, str(pick('deepseek_api_key', ''), '')) || null,
    fakeMeters: fakeMeters(env.USAGE_RELAY_FAKE_METERS),
    reset: env.USAGE_RELAY_RESET === '1',
  }
}
