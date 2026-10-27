import type { PluginOptions } from 'claude-code'

export type Role = 'claude' | 'deepseek' | 'none'

export type Config = {
  fiveHourThreshold: number
  resumeBelow: number
  sevenDayThreshold: number
  pollSeconds: number
  handoffFile: string
  claudeModel: string
  deepseekModel: string
  enabled: boolean
  role: Role
  fakeFiveHour: number | null
  fakeSevenDay: number | null
}

const DEFAULTS = {
  fiveHourThreshold: 90,
  resumeBelow: 5,
  sevenDayThreshold: 90,
  pollSeconds: 60,
  handoffFile: 'HANDOFF.md',
  claudeModel: 'Claude Code API/claude-opus-5-5[1m]',
  deepseekModel: 'DeepSeek/deepseek-flash',
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function role(value: string | undefined): Role {
  return value === 'claude' || value === 'deepseek' ? value : 'none'
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

  return {
    fiveHourThreshold: num(
      env.USAGE_RELAY_5H,
      num(pick('five_hour_threshold', DEFAULTS.fiveHourThreshold), DEFAULTS.fiveHourThreshold),
    ),
    resumeBelow: num(
      env.USAGE_RELAY_RESUME_BELOW,
      num(pick('resume_below', DEFAULTS.resumeBelow), DEFAULTS.resumeBelow),
    ),
    sevenDayThreshold: num(
      env.USAGE_RELAY_7D,
      num(pick('seven_day_threshold', DEFAULTS.sevenDayThreshold), DEFAULTS.sevenDayThreshold),
    ),
    pollSeconds: Math.max(
      5,
      num(env.USAGE_RELAY_POLL, num(pick('poll_seconds', DEFAULTS.pollSeconds), DEFAULTS.pollSeconds)),
    ),
    handoffFile: str(
      env.USAGE_RELAY_HANDOFF,
      str(pick('handoff_file', DEFAULTS.handoffFile), DEFAULTS.handoffFile),
    ),
    claudeModel: str(
      env.USAGE_RELAY_CLAUDE_MODEL,
      str(pick('claude_model', DEFAULTS.claudeModel), DEFAULTS.claudeModel),
    ),
    deepseekModel: str(
      env.USAGE_RELAY_DEEPSEEK_MODEL,
      str(pick('deepseek_model', DEFAULTS.deepseekModel), DEFAULTS.deepseekModel),
    ),
    enabled: pick('enabled', true) !== false && env.USAGE_RELAY_DISABLED !== '1',
    role: role(env.USAGE_RELAY_ROLE),
    fakeFiveHour: env.USAGE_RELAY_FAKE_5H === undefined ? null : num(env.USAGE_RELAY_FAKE_5H, NaN) || 0,
    fakeSevenDay: env.USAGE_RELAY_FAKE_7D === undefined ? null : num(env.USAGE_RELAY_FAKE_7D, NaN) || 0,
  }
}
