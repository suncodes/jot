import fs from 'node:fs'
import { planWorkReport, type WorkReportRequest, type WorkReportSource } from '@shared/work-reports'
import { JotError } from '@shared/result'
import type { Core } from '../core'

export class WorkReportService {
  constructor(private readonly core: Core) {}

  profiles() { return this.core.extensions.workReportProfiles() }

  async prepare(source: WorkReportSource, request: WorkReportRequest) {
    const paths = source.kind === 'paths' ? source.paths : await this.profilePaths(source)
    return planWorkReport(paths, request, this.core.now())
  }

  private async profilePaths(source: Extract<WorkReportSource, { kind: 'profile' }>) {
    const result = await this.profiles()
    const profile = result.profiles.find(profile => profile.extensionId === source.extensionId && profile.profileId === source.profileId)
    if (!profile) throw new JotError('NOT_FOUND', '工作日记入口不存在或不可用，请重新查询 work_reports.profiles。'
      + result.issues.filter(issue => issue.extensionId === source.extensionId).map(issue => issue.message).join('；'))
    return profile.paths
  }

  async write(source: WorkReportSource, request: WorkReportRequest, body: string, signal?: AbortSignal) {
    if (signal?.aborted) throw new JotError('CANCELLED', '操作已停止')
    const target = await this.prepare(source, request)
    const result: { updated: string[]; failed: { path: string; message: string }[] } = { updated: [], failed: [] }
    await this.core.mutate(async () => {
      if (signal?.aborted) throw new JotError('CANCELLED', '操作已停止')
      try {
        const vault = this.core.vault
        if (await fs.promises.stat(vault.abs(target.path)).catch(error => { if (error.code === 'ENOENT') return null; throw error })) await vault.saveCurrentBody(target.path, body)
        else await vault.createText(target.path, body)
        const saved = await vault.read({ path: target.path })
        if (saved.body !== body) throw new JotError('IO_ERROR', '报告已写入，但回读正文与本次提交不一致，请检查当前文件后再处理')
        result.updated.push(target.path)
      } catch (error) { result.failed.push({ path: target.path, message: (error as Error).message }) }
    })
    await this.core.idle()
    return { path: target.path, ...result,
      ...(result.updated.includes(target.path) ? { link: '[' + target.path.split('/').at(-1) + '](' + encodeURI(target.path).replace(/[?#()[\]]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase()) + ')' } : {}) }
  }
}
