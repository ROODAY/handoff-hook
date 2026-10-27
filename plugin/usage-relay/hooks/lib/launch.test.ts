import { expect, test } from 'claude-code/testing'
import { buildLaunchArgv, initialPrompt } from './launch'
import type { Config } from './config'

const config: Config = {
  fiveHourThreshold: 90, resumeBelow: 5, sevenDayThreshold: 90, pollSeconds: 60,
  handoffFile: 'HANDOFF.md', claudeModel: 'Claude Code API/claude-opus-5-5[1m]',
  deepseekModel: 'DeepSeek/deepseek-flash', enabled: true, role: 'claude',
  fakeFiveHour: null, fakeSevenDay: null,
}

function decode(b64: string): string {
  const bin = atob(b64)
  let out = ''
  for (let i = 0; i + 1 < bin.length; i += 2) {
    out += String.fromCharCode(bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8))
  }
  return out
}

test('a deepseek launch names the tab, directory, role and model', () => {
  const argv = buildLaunchArgv({ root: 'C:/work/proj', target: 'deepseek', config })
  expect(argv.slice(0, 9)).toEqual([
    'wt', '-w', '0', 'new-tab', '-d', 'C:/work/proj', 'pwsh', '-NoExit', '-EncodedCommand',
  ])
  expect(decode(argv[9])).toBe(
    "$env:USAGE_RELAY_ROLE='deepseek'; & claude --model 'DeepSeek/deepseek-flash' 'Read HANDOFF.md in this directory and continue the work it describes.'",
  )
})

test('a claude launch uses the configured claude model', () => {
  const argv = buildLaunchArgv({ root: 'C:/w', target: 'claude', config })
  const decoded = decode(argv[9])
  expect(decoded).toContain("USAGE_RELAY_ROLE='claude'")
  expect(decoded).toContain("--model 'Claude Code API/claude-opus-5-5[1m]'")
})

test('the encoded command carries no shell metacharacters wt could split on', () => {
  const argv = buildLaunchArgv({ root: 'C:/w', target: 'claude', config })
  expect(argv[9]).toMatch(/^[A-Za-z0-9+/]+=*$/)
})

test('the initial prompt is model-neutral and names the handoff', () => {
  expect(initialPrompt()).toBe(
    'Read HANDOFF.md in this directory and continue the work it describes.',
  )
})
