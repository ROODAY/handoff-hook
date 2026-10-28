export type MeterType = 'claude-oauth' | 'deepseek-balance' | 'session-spend'

export type ChainStep = {
  id: string
  label: string
  model: string
  meter: Record<string, unknown> & { type: MeterType }
}

export type Chain = { id: string; steps: ChainStep[] }

export const KNOWN_API_KEY_ENVS: readonly string[] = ['DEEPSEEK_API_KEY']

const METER_TYPES: readonly MeterType[] = ['claude-oauth', 'deepseek-balance', 'session-spend']
const ID = /^[a-z0-9_-]+$/

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validateMeter(index: number, meter: unknown): string | null {
  const where = `chain: step ${index}`
  if (!isRecord(meter)) return `${where} needs a meter object`
  const type = meter.type
  if (typeof type !== 'string' || !(METER_TYPES as readonly string[]).includes(type)) {
    return `${where} has an unknown meter type "${String(type)}"`
  }
  if (type === 'claude-oauth') {
    const at = meter.exhaust_at
    if (!isRecord(at) || !isNumber(at.five_hour)) {
      return `${where} claude-oauth needs exhaust_at.five_hour as a number`
    }
    const pause = meter.pause_at
    if (pause !== undefined && (!isRecord(pause) || !isNumber(pause.seven_day))) {
      return `${where} claude-oauth pause_at.seven_day must be a number`
    }
    const resume = meter.resume_below
    if (resume !== undefined && (!isRecord(resume) || !isNumber(resume.five_hour))) {
      return `${where} claude-oauth resume_below.five_hour must be a number`
    }
    return null
  }
  if (type === 'deepseek-balance') {
    const env = meter.api_key_env
    if (typeof env !== 'string' || !KNOWN_API_KEY_ENVS.includes(env)) {
      return `${where} deepseek-balance api_key_env must be one of ${KNOWN_API_KEY_ENVS.join(', ')}`
    }
    for (const field of ['exhaust_below', 'resume_above'] as const) {
      const v = meter[field]
      if (v === undefined && field === 'resume_above') continue
      if (!isRecord(v) || !isNumber(v.amount) || typeof v.currency !== 'string' || v.currency.length === 0) {
        return `${where} deepseek-balance ${field} needs { amount: number, currency: string }`
      }
    }
    return null
  }
  if (!isNumber(meter.exhaust_at_usd)) {
    return `${where} session-spend needs exhaust_at_usd as a number`
  }
  return null
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function chainIdOf(text: string): string {
  return fnv1a(text)
}

export function parseChain(text: string): { chain: Chain } | { error: string } {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { error: 'chain: the file is not valid JSON' }
  }
  if (!Array.isArray(body)) return { error: 'chain: expected a JSON array of steps' }
  if (body.length === 0) return { error: 'chain: at least one step is required' }

  const seen = new Set<string>()
  const steps: ChainStep[] = []
  for (let i = 0; i < body.length; i++) {
    const raw = body[i]
    if (!isRecord(raw)) return { error: `chain: step ${i} is not an object` }
    const id = raw.id
    if (typeof id !== 'string' || !ID.test(id)) {
      return { error: `chain: step ${i} has an invalid id (use a-z, 0-9, _, -)` }
    }
    if (seen.has(id)) return { error: `chain: duplicate step id "${id}"` }
    seen.add(id)
    if (typeof raw.model !== 'string' || raw.model.length === 0) {
      return { error: `chain: step ${i} (${id}) needs a model` }
    }
    const meterError = validateMeter(i, raw.meter)
    if (meterError) return { error: meterError }
    steps.push({
      id,
      label: typeof raw.label === 'string' && raw.label.length > 0 ? raw.label : id,
      model: raw.model,
      meter: raw.meter as ChainStep['meter'],
    })
  }

  return { chain: { id: fnv1a(JSON.stringify(steps)), steps } }
}

function normalizeModel(model: string): string {
  return model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '')
}

export function matchStepByModel(chain: Chain, model: string): ChainStep | null {
  const wanted = normalizeModel(model)
  if (wanted.length === 0) return null
  for (const step of chain.steps) {
    if (normalizeModel(step.model) === wanted) return step
  }
  return null
}
