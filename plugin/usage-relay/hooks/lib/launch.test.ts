import { expect, test } from 'claude-code/testing'
import { buildLaunchArgv, initialPrompt } from './launch'
import type { Config } from './config'
import type { ChainStep } from './chain'

const config: Config = {
  fiveHourThreshold: 90, resumeBelow: 5, sevenDayThreshold: 90, pollSeconds: 60,
  handoffFile: 'HANDOFF.md', claudeModel: 'Claude Code API/claude-opus-5-5[1m]',
  deepseekModel: 'DeepSeek/deepseek-flash', enabled: true, role: 'claude',
  fakeFiveHour: null, fakeSevenDay: null, terminal: 'wt',
}
const step: ChainStep = {
  id: 'deepseek', label: 'DeepSeek', model: 'DeepSeek/deepseek-flash',
  meter: { type: 'session-spend', exhaust_at_usd: 2 },
}

function decode(b64: string): string {
  const bin = atob(b64)
  let out = ''
  for (let i = 0; i + 1 < bin.length; i += 2) {
    out += String.fromCharCode(bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8))
  }
  return out
}

test('a launch sets the step, chain file and enablement, and runs the step model', () => {
  const argv = buildLaunchArgv({ root: 'C:/w', step, chainFile: 'C:/chain.json', config })
  expect(argv.slice(0, 7)).toEqual(['wt', '-w', '0', 'new-tab', '-d', 'C:/w', 'pwsh'])
  const decoded = decode(argv[9])
  expect(decoded).toContain("USAGE_RELAY_STEP='deepseek'")
  expect(decoded).toContain("USAGE_RELAY_CHAIN_FILE='C:/chain.json'")
  expect(decoded).toContain("USAGE_RELAY_ENABLED='1'")
  expect(decoded).toContain("--model 'DeepSeek/deepseek-flash'")
  expect(decoded).toContain("'Read HANDOFF.md in this directory and continue the work it describes.'")
})

test('a configured terminal is the program that gets launched', () => {
  const argv = buildLaunchArgv({
    root: 'C:/w', step, chainFile: 'C:/chain.json',
    config: { ...config, terminal: 'C:\\Tools\\WindowsTerminal.exe' },
  })
  expect(argv[0]).toBe('C:\\Tools\\WindowsTerminal.exe')
  expect(argv.slice(1, 7)).toEqual(['-w', '0', 'new-tab', '-d', 'C:/w', 'pwsh'])
})

test('the encoded command carries no shell metacharacters wt could split on', () => {
  const argv = buildLaunchArgv({ root: 'C:/w', step, chainFile: 'C:/chain.json', config })
  expect(argv[9]).toMatch(/^[A-Za-z0-9+/]+=*$/)
})

test('the initial prompt is model-neutral and names the handoff', () => {
  expect(initialPrompt('HANDOFF.md')).toBe(
    'Read HANDOFF.md in this directory and continue the work it describes.',
  )
})

test('a value with a single quote is refused rather than silently broken', () => {
  expect(() => buildLaunchArgv({
    root: 'C:/w', step: { ...step, model: "bad'model" }, chainFile: 'C:/chain.json', config,
  })).toThrow()
})
