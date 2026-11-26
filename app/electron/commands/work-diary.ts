import path from 'node:path'
import type { CommandResult } from '@shared/commands'
import { previewWorkReportMonth, type WorkReportOptions } from '@shared/work-reports'
import type { Core } from '../core'
import { localIso } from '../util/time'
import type { CommandContext } from './service'

export class WorkDiaryService {
  constructor(private readonly core: Core) {}

  async execute(extensionId: string, options: WorkReportOptions, context: CommandContext): Promise<Extract<CommandResult, { kind: 'open-note' }>> {
    const now = this.core.now()
    const target = previewWorkReportMonth(options, now)
    const input = (rel: string) => ({ date: target.date, title: path.posix.basename(rel).replace(/\.(md|markdown)$/i, ''), created: localIso(now) })
    const result = await context.mutate(async () => {
      if (!await this.core.vault.contentDirectoryExists(target.draftDirectory)) {
        const okr = options.okrTemplate === null ? null : await this.core.templates.render(extensionId, options.okrTemplate, input(target.draftOkrPath))
        await this.core.vault.ensureContentDirectories(target.directories)
        if (okr !== null) await this.core.vault.createOrOpenNote(target.draftOkrPath, async () => okr)
      }
      return this.core.vault.createOrOpenNote(target.dailyDraft.path, () => this.core.templates.render(extensionId, options.template, input(target.dailyDraft.path)))
    })
    await this.core.idle()
    return { kind: 'open-note', ...result }
  }
}
