import { expect, test } from 'claude-code/testing'
import { gateTool } from './gate'

const G = { kind: 'handoff' as const, root: 'C:/work/proj', handoffFile: 'HANDOFF.md' }

test('reads are always allowed while handing off', () => {
  for (const tool of ['Read', 'Glob', 'Grep']) {
    expect(gateTool(G, tool, { file_path: 'C:/work/proj/src/a.ts' })).toBeNull()
  }
})

test('writing the handoff is allowed with any slash style or case', () => {
  for (const p of ['C:/work/proj/HANDOFF.md', 'C:\\work\\proj\\handoff.md', 'HANDOFF.md']) {
    expect(gateTool(G, 'Write', { file_path: p })).toBeNull()
    expect(gateTool(G, 'Edit', { file_path: p })).toBeNull()
  }
})

test('writing any other file is denied', () => {
  expect(gateTool(G, 'Write', { file_path: 'C:/work/proj/src/a.ts' })?.deny)
    .toContain('HANDOFF.md')
})

test('a shell or network tool is denied', () => {
  expect(gateTool(G, 'Bash', { command: 'ls' })?.deny).toBeTruthy()
  expect(gateTool(G, 'WebFetch', { url: 'https://x' })?.deny).toBeTruthy()
})

test('the 7d gate still allows reads and only reads', () => {
  const g = { ...G, kind: 'seven_day' as const }
  expect(gateTool(g, 'Read', { file_path: 'x' })).toBeNull()
  expect(gateTool(g, 'Write', { file_path: 'C:/work/proj/HANDOFF.md' })?.deny).toContain('7-day')
})
