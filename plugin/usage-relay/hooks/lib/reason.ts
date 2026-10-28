export const HANDOFF_TEMPLATE = `# Handoff
## Goal
## Current status (done / in progress / not started)
## Exact next steps (numbered, concrete, smallest-first)
## Files touched and why (paths)
## Commands to build / test / run
## Decisions made and rationale
## Gotchas, failed approaches, things NOT to do
## Open questions for the user`

const PLAIN_MARKDOWN =
  'Write plain markdown, model-neutral: no tool-call syntax, no XML tags, no references to conversation the reader cannot see.'

export function handoffReason(percent: number, handoffFile: string): string {
  return (
    `Usage is at ${Math.round(percent)}% of the 5-hour cap. Stop the current task. ` +
    `Write ${handoffFile} in the project root using this template, then end your turn. ` +
    `${PLAIN_MARKDOWN}\n\n${HANDOFF_TEMPLATE}`
  )
}

export function handoffReminder(handoffFile: string): string {
  return (
    `Usage is near the 5-hour cap. ${handoffFile} is the only file you may write; ` +
    `reading tools are allowed. Write ${handoffFile} using the template, then end your turn. ${PLAIN_MARKDOWN}`
  )
}

export function sevenDayReason(percent: number): string {
  return (
    `Weekly usage is at ${Math.round(percent)}% of the 7-day cap. Work paused; tell the person ` +
    `to run /relay resume or wait for the reset. Only reading tools are allowed.`
  )
}

export const SEVEN_DAY_DENY =
  'Weekly usage is at the 7-day cap. Work paused; run /relay resume or wait for the reset. Only reading tools are allowed.'

export function moveReason(from: string, to: string, handoffFile: string): string {
  return (
    `The relay is moving this work from ${from} to ${to}. Stop the current task. ` +
    `Write ${handoffFile} in the project root using this template, then end your turn. ` +
    `${PLAIN_MARKDOWN}

${HANDOFF_TEMPLATE}`
  )
}

export function handoffRequestToClaude(handoffFile: string): string {
  return (
    `Claude's 5-hour window has reset and Claude is available again. Write ${handoffFile} in the ` +
    `project root for the session that will continue the work, then end your turn. ${PLAIN_MARKDOWN}\n\n${HANDOFF_TEMPLATE}`
  )
}
