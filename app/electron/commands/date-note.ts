import type { DailyNoteProfile } from '@shared/app-extensions'
import type { CommandResult } from '@shared/commands'
import { previewDateNote } from '@shared/date-paths'
import { JotError } from '@shared/result'
import type { Core } from '../core'
import { localIso } from '../util/time'
import type { CommandContext } from './service'

export class DateNoteService {
  constructor(private readonly core: Core) {}

  async execute(extensionId: string, profile: DailyNoteProfile, context: CommandContext): Promise<Extract<CommandResult, { kind: 'open-note' }>> {
    if (profile.options.directory === null) throw new JotError('INVALID_INPUT', '请选择保存目录')
    const now = this.core.now()
    const target = previewDateNote({ directory: profile.options.directory, filename: profile.options.filename }, now)
    const result = await context.mutate(() => this.core.vault.createOrOpenNote(target.path, () =>
      this.core.templates.render(extensionId, profile.options.template, {
        date: target.date, title: target.filename.replace(/\.(md|markdown)$/i, ''), created: localIso(now),
      })))
    await this.core.idle()
    return { kind: 'open-note', ...result }
  }
}
