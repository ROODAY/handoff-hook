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
  target: 'claude' | 'deepseek'
  config: Config
}): string[] {
  const model = spec.target === 'deepseek' ? spec.config.deepseekModel : spec.config.claudeModel
  const command =
    `$env:USAGE_RELAY_ROLE=${quoted(spec.target, 'role')}; ` +
    `& claude --model ${quoted(model, 'model')} ${quoted(initialPrompt(spec.config.handoffFile), 'prompt')}`
  return [
    spec.config.terminal, '-w', '0', 'new-tab', '-d', spec.root,
    'pwsh', '-NoExit', '-EncodedCommand', utf16leBase64(command),
  ]
}
