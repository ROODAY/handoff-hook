import { expect, mock, test } from 'claude-code/testing'

const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const CHAIN = JSON.stringify([
  { id: 'claude', label: 'Claude', model: 'cm', meter: { type: 'claude-oauth', exhaust_at: { five_hour: 90 }, pause_at: { seven_day: 90 }, resume_below: { five_hour: 5 } } },
  { id: 'deepseek', label: 'DeepSeek', model: 'dm', meter: { type: 'deepseek-balance', api_key_env: 'DEEPSEEK_API_KEY', exhaust_below: { amount: 2, currency: 'USD' } } },
])

function seat(on: any, statuses: (string | undefined)[], chainText: string | undefined): void {
  mock.clock(on)
  mock.store(on)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.model', () => ({ value: 'cm' }))
  on('fs.read', (_$: any, e: any) => ({
    value: e.path.includes('chain') ? chainText : undefined,
  }))
  on('fs.stat', () => ({ value: { kind: 'other', size: 0, mtimeMs: 0, isLink: false } }))
  on('command.register', (_$: any, e: any) => ({ value: { command: e.command } }))
  on('ui.status', (_$: any, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
}

test('a disabled session does nothing and allows tools', async ($, on) => {
  const statuses: (string | undefined)[] = []
  seat(on, statuses, CHAIN)
  mock.env(on, { USAGE_RELAY_CHAIN_FILE: 'C:/chain.json', USERPROFILE: 'C:/Users/me' })

  await $.session.start(SESSION)

  expect(statuses).toContain('usage-relay: disabled')
  const allowed = await $.tool.call({ tool: 'Bash', command: 'echo hi' })
  expect(allowed.text).toBe('ok')
})

test('enabling with no chain is refused', async ($, on) => {
  const statuses: (string | undefined)[] = []
  seat(on, statuses, undefined)
  mock.env(on, { USAGE_RELAY_CHAIN_FILE: 'C:/chain.json', USERPROFILE: 'C:/Users/me' })

  await $.session.start(SESSION)
  const out = await $.command.run({ command: 'relay', args: 'enable' })

  expect(out.text).toContain('No chain configured')
  const allowed = await $.tool.call({ tool: 'Bash', command: 'echo hi' })
  expect(allowed.text).toBe('ok')
})

test('an enabled session over the limit denies tools and asks for a handoff', async ($, on) => {
  const statuses: (string | undefined)[] = []
  seat(on, statuses, CHAIN)
  mock.env(on, {
    USAGE_RELAY_CHAIN_FILE: 'C:/chain.json',
    USERPROFILE: 'C:/Users/me',
    USAGE_RELAY_STEP: 'claude',
    USAGE_RELAY_ENABLED: '1',
    USAGE_RELAY_FAKE_METERS: '{"claude":{"exhausted":true,"available":false},"deepseek":{"exhausted":false,"available":true}}',
  })

  await $.session.start(SESSION)

  const denied = await $.tool.call({ tool: 'Bash', command: 'echo hi' })
  expect(denied.deny ?? denied.text).toContain('HANDOFF.md')
  const allowed = await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
  expect(allowed.text).toBe('ok')
})
