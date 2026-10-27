import { expect, test } from 'claude-code/testing'
import { readConfig } from './config'

test('defaults fill in when options are empty', () => {
  const c = readConfig({}, {})
  expect(c.fiveHourThreshold).toBe(90)
  expect(c.sevenDayThreshold).toBe(90)
  expect(c.role).toBe('none')
  expect(c.enabled).toBe(true)
})

test('env overrides options and role is read from USAGE_RELAY_ROLE', () => {
  const c = readConfig({ five_hour_threshold: 80 }, {
    USAGE_RELAY_ROLE: 'deepseek',
    USAGE_RELAY_5H: '85',
    USAGE_RELAY_FAKE_5H: '95',
  })
  expect(c.fiveHourThreshold).toBe(85)
  expect(c.role).toBe('deepseek')
  expect(c.fakeFiveHour).toBe(95)
})

test('the launch terminal defaults to wt and is overridable', () => {
  expect(readConfig({}, {}).terminal).toBe('wt')
  expect(readConfig({ terminal: 'preview' }, {}).terminal).toBe('preview')
  expect(readConfig({}, { USAGE_RELAY_TERMINAL: 'preview' }).terminal).toBe('preview')
})

test('USAGE_RELAY_DISABLED turns the guard off', () => {
  expect(readConfig({}, { USAGE_RELAY_DISABLED: '1' }).enabled).toBe(false)
})
