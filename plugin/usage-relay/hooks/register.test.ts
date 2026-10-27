import { expect, mock, test } from 'claude-code/testing'

const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' }

function seat(
  on: any,
  statuses: (string | undefined)[],
  submitted: string[] = [],
): void {
  mock.clock(on)
  mock.store(on)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/work' }))
  on('fs.stat', () => ({
    value: { kind: 'other', size: 0, mtimeMs: 0, isLink: false },
  }))
  on('command.register', (_$: any, e: any) => ({ value: { command: e.command } }))
  on('ui.status', (_$: any, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('prompt.submit', (_$: any, e: any) => {
    submitted.push(e.text)
    return { text: e.text }
  })
}

test('a claude session over the threshold shows usage, denies Bash and allows reads', async ($, on) => {
  const statuses: (string | undefined)[] = []
  seat(on, statuses)
  mock.env(on, { USAGE_RELAY_ROLE: 'claude', USAGE_RELAY_FAKE_5H: '95' })

  await $.session.start(SESSION)

  expect(statuses.some(line => line?.includes('5h 95%'))).toBe(true)
  const denied = await $.tool.call({ tool: 'Bash', command: 'echo hi' })
  expect(denied.deny ?? denied.text).toContain('HANDOFF.md')
  const allowed = await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
  expect(allowed.text).toBe('ok')
})

test('a session with no role shows usage but never gates', async ($, on) => {
  const statuses: (string | undefined)[] = []
  seat(on, statuses)
  mock.env(on, { USAGE_RELAY_FAKE_5H: '95' })

  await $.session.start(SESSION)

  expect(statuses.some(line => line?.includes('5h 95%'))).toBe(true)
  const allowed = await $.tool.call({ tool: 'Bash', command: 'echo hi' })
  expect(allowed.text).toBe('ok')
})

test('a deepseek session below the resume line submits the return prompt', async ($, on) => {
  const statuses: (string | undefined)[] = []
  const submitted: string[] = []
  seat(on, statuses, submitted)
  mock.env(on, { USAGE_RELAY_ROLE: 'deepseek', USAGE_RELAY_FAKE_5H: '0' })

  await $.session.start(SESSION)

  expect(submitted.some(text => text.includes('window has reset'))).toBe(true)
})

test('the stop hook blocks while the handoff is unwritten', async ($, on) => {
  const statuses: (string | undefined)[] = []
  seat(on, statuses)
  mock.env(on, { USAGE_RELAY_ROLE: 'claude', USAGE_RELAY_FAKE_5H: '95' })

  await $.session.start(SESSION)

  const stopped = await $.classic.Stop({ stop_hook_active: false })
  expect(stopped.block).toContain('HANDOFF.md')
})
