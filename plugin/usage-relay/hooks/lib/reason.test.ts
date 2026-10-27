import { expect, test } from 'claude-code/testing'
import { HANDOFF_TEMPLATE, handoffReason, sevenDayReason } from './reason'

test('the handoff reason carries the template and the ban on chat-isms', () => {
  const r = handoffReason(93.2, 'HANDOFF.md')
  expect(r).toContain('HANDOFF.md')
  expect(r).toContain('93')
  expect(r).toContain(HANDOFF_TEMPLATE)
  expect(r).toContain('no tool-call syntax')
  expect(r).toContain('no references to conversation the reader cannot see')
})

test('the 7d reason says work is paused and names /relay resume', () => {
  const r = sevenDayReason(95)
  expect(r).toContain('7-day')
  expect(r).toContain('/relay resume')
})
