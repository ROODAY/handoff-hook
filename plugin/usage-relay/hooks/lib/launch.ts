import type { ChainStep } from './chain'
import type { Config } from './config'

export function initialPrompt(handoffFile: string): string {
  return `Read ${handoffFile} in this directory and continue the work it describes.`
}

function utf16leBase64(text: string): string {
  let bin = ''
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    bin += String.fromCharCode(c & 0xff, (c >> 8) & 0xff)
  }
  return btoa(bin)
}

function quoted(value: string, what: string): string {
  if (value.includes("'")) throw new Error(`usage-relay: ${what} contains a single quote`)
  return `'${value}'`
}

export function buildLaunchArgv(spec: {
  root: string
  step: ChainStep
  chainFile: string
  config: Config
}): string[] {
  const command =
    `$env:USAGE_RELAY_STEP=${quoted(spec.step.id, 'step')}; ` +
    `$env:USAGE_RELAY_CHAIN_FILE=${quoted(spec.chainFile, 'chain file')}; ` +
    `$env:USAGE_RELAY_ENABLED='1'; ` +
    `& claude --model ${quoted(spec.step.model, 'model')} ${quoted(initialPrompt(spec.config.handoffFile), 'prompt')}`
  return [
    spec.config.terminal, '-w', '0', 'new-tab', '-d', spec.root,
    'pwsh', '-NoExit', '-EncodedCommand', utf16leBase64(command),
  ]
}
