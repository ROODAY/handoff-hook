import { handoffReminder, SEVEN_DAY_DENY } from './reason'

export type GateInput = {
  kind: 'handoff' | 'seven_day'
  root: string
  handoffFile: string
}

const READS = new Set(['Read', 'Glob', 'Grep'])
const WRITES = new Set(['Write', 'Edit'])

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function targetsHandoff(input: Record<string, unknown>, g: GateInput): boolean {
  const raw = input.file_path ?? input.path
  if (typeof raw !== 'string' || raw.length === 0) return false
  const value = norm(raw)
  const handoff = norm(g.handoffFile)
  if (value === handoff) return true
  const root = norm(g.root)
  return value.startsWith(root + '/') && value.slice(root.length + 1) === handoff
}

export function gateTool(
  g: GateInput,
  tool: string,
  input: Record<string, unknown>,
): { deny: string } | null {
  if (READS.has(tool)) return null
  if (g.kind === 'handoff' && WRITES.has(tool) && targetsHandoff(input, g)) return null
  return { deny: g.kind === 'seven_day' ? SEVEN_DAY_DENY : handoffReminder(g.handoffFile) }
}
