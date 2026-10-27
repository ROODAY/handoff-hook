import type { PluginOptions, Register } from 'claude-code'

export const register: Register = (on, _options: PluginOptions) => {
  on('session.start', ($, e, next) => {
    $.ui.status('usage-relay loaded')
    return next(e)
  })
}
