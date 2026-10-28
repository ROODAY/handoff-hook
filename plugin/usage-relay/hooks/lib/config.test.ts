import { expect, test } from 'claude-code/testing'
import { readConfig } from './config'

test('disabled by default, with the documented defaults', () => {
  const c = readConfig({}, { USERPROFILE: 'C:/Users/me' })
  expect(c.enabled).toBe(false)
  expect(c.pollSeconds).toBe(60)
  expect(c.terminal).toBe('wt')
  expect(c.handoffFile).toBe('HANDOFF.md')
  expect(c.chainFile).toBe('C:/Users/me\\.claude\\usage-relay\\chain.json')
})

test('the chain file comes from options or the environment', () => {
  expect(readConfig({ chain_file: 'D:/chain.json' }, {}).chainFile).toBe('D:/chain.json')
  expect(readConfig({}, { USAGE_RELAY_CHAIN_FILE: 'E:/c.json' }).chainFile).toBe('E:/c.json')
})

test('enablement: options default, env overrides both ways', () => {
  expect(readConfig({ enabled: true }, {}).enabled).toBe(true)
  expect(readConfig({}, { USAGE_RELAY_ENABLED: '1' }).enabled).toBe(true)
  expect(readConfig({ enabled: true }, { USAGE_RELAY_ENABLED: '0' }).enabled).toBe(false)
  expect(readConfig({}, { USAGE_RELAY_DISABLED: '1' }).enabled).toBe(false)
})

test('fake meters parse from JSON and invalid JSON is ignored', () => {
  const good = readConfig({}, { USAGE_RELAY_FAKE_METERS: '{"claude":{"exhausted":true}}' })
  expect(good.fakeMeters?.claude.exhausted).toBe(true)
  expect(readConfig({}, { USAGE_RELAY_FAKE_METERS: 'oops' }).fakeMeters).toBeNull()
})

test('the api key prefers the environment', () => {
  expect(readConfig({ deepseek_api_key: 'from-config' }, {}).deepseekApiKey).toBe('from-config')
  expect(readConfig({ deepseek_api_key: 'from-config' }, { DEEPSEEK_API_KEY: 'from-env' }).deepseekApiKey).toBe('from-env')
})
