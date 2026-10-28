import { expect, test } from 'claude-code/testing'
import { matchStepByModel, parseChain } from './chain'

const CLAUDE = {
  id: 'claude', label: 'Claude', model: 'Claude Code API/claude-opus-5-5[1m]',
  meter: { type: 'claude-oauth', exhaust_at: { five_hour: 90 }, pause_at: { seven_day: 90 }, resume_below: { five_hour: 5 } },
}
const DEEPSEEK = {
  id: 'deepseek', label: 'DeepSeek', model: 'DeepSeek/deepseek-flash',
  meter: { type: 'deepseek-balance', api_key_env: 'DEEPSEEK_API_KEY',
    exhaust_below: { amount: 2, currency: 'USD' }, resume_above: { amount: 3, currency: 'USD' } },
}
const good = () => JSON.stringify([CLAUDE, DEEPSEEK])

test('a valid chain parses and gets a stable id', () => {
  const a = parseChain(good())
  const b = parseChain(good())
  expect('chain' in a && a.chain.steps.map(s => s.id)).toEqual(['claude', 'deepseek'])
  expect('chain' in a && 'chain' in b && a.chain.id === b.chain.id).toBe(true)
})

test('a changed chain gets a different id', () => {
  const a = parseChain(good())
  const b = parseChain(JSON.stringify([CLAUDE]))
  expect('chain' in a && 'chain' in b && a.chain.id === b.chain.id).toBe(false)
})

test('invalid chains are refused whole with a reason', () => {
  const cases: [string, RegExp][] = [
    ['not json', /JSON/],
    ['{}', /array/],
    ['[]', /empty|at least one/],
    [JSON.stringify([{ ...CLAUDE, id: 'Bad Id' }]), /id/],
    [JSON.stringify([CLAUDE, { ...DEEPSEEK, id: 'claude' }]), /duplicate/i],
    [JSON.stringify([{ ...CLAUDE, model: '' }]), /model/],
    [JSON.stringify([{ ...CLAUDE, meter: { type: 'nope' } }]), /meter/],
    [JSON.stringify([{ ...CLAUDE, meter: { type: 'deepseek-balance', api_key_env: 'OTHER_KEY', exhaust_below: { amount: 2, currency: 'USD' } } }]), /DEEPSEEK_API_KEY/],
  ]
  for (const [text, pattern] of cases) {
    const r = parseChain(text)
    expect('error' in r && pattern.test(r.error)).toBe(true)
  }
})

test('model matching tolerates case and a trailing context suffix', () => {
  const parsed = parseChain(good())
  const c = 'chain' in parsed ? parsed.chain : { id: '', steps: [] }
  expect(matchStepByModel(c, 'claude code api/claude-opus-5-5')?.id).toBe('claude')
  expect(matchStepByModel(c, 'DeepSeek/DeepSeek-Flash')?.id).toBe('deepseek')
  expect(matchStepByModel(c, 'gpt-5')).toBeNull()
})
