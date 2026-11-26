import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { JotError } from '@shared/result'
import type { FileItem, FileState, LibrarySource, Paged } from '@shared/types'
import type { IndexService } from '../index/index'
import type { StateStore } from '../state/state'
import { pathJobKey, type JobQueue } from '../jobs/queue'
import { coverageNote, type AiExecutor, type AiExecution } from '../agent/executor'
import { localIso } from '../util/time'
import { isMarkdown } from '../vault/doc'
import { parseDoc } from '../vault/frontmatter'
import { DIRS, isInUserContent, monthlyPath } from '../vault/paths'
import { isSidecar } from '../vault/metadata'
import { isTextFile, type VaultService } from '../vault/vault'

// 文件处理：原件与附属属性 → 查询索引 → 按明确导入意图生成摘要；相同内容副本独立。
// 模型归纳由共用执行器和技能完成，程序负责原件、任务及保存。见 docs/user-guide.md、docs/architecture.md。

/** 超过这个大小的文件不解析 */
const MAX_BYTES = 10 * 1024 * 1024
const clip = (max: number) => z.string().transform((v) => v.trim().slice(0, max))
const list = (max: number, each = 200) =>
  z.array(z.string()).nullish().transform((a) => [...new Set((a ?? []).map((x) => x.trim().slice(0, each)).filter(Boolean))].slice(0, max))

export const SummaryOutput = z.object({
  oneLine: clip(80),
  points: list(8).refine((a) => a.length >= 1, '至少要有一条要点'),
  entities: z
    .object({ projects: list(10, 40), people: list(10, 40), dates: list(10, 40), numbers: list(10, 60) })
    .nullish()
    .transform((e) => e ?? { projects: [], people: [], dates: [], numbers: [] }),
})
export type SummaryOutput = z.infer<typeof SummaryOutput>
const CONTRACT = '仅返回JSON：{"oneLine":"一句话","points":["具体要点"],"entities":{"projects":[],"people":[],"dates":[],"numbers":[]}}。'

/** 摘要页的正文由程序按固定格式生成，不让模型直接写文件内容 */
export function renderSummary(out: SummaryOutput, note?: string): string {
  const lines = [out.oneLine, '', '## 要点', '', ...out.points.map((p) => `- ${p}`)]
  const e = out.entities
  const groups: [string, string[]][] = [['项目', e.projects], ['人物', e.people], ['日期', e.dates], ['数字', e.numbers]]
  if (groups.some(([, v]) => v.length)) {
    lines.push('', '## 关键名称', '')
    for (const [label, values] of groups) if (values.length) lines.push(`- ${label}：${values.join('、')}`)
  }
  if (note) lines.push('', `> ${note}`)
  return lines.join('\n') + '\n'
}

export interface FileArchiveDeps {
  vault: VaultService
  index: IndexService
  jobs: JobQueue
  executor: AiExecutor
  state: StateStore
  mutate: <T>(operation: () => Promise<T>) => Promise<T>
  /** 把一个文件写进索引 */
  indexFile: (rel: string) => Promise<unknown>
  now: () => Date
  /** 文件归档的内容有变化，通知界面刷新 */
  changed: () => void
}

const jobKey = (rel: string) => pathJobKey('summarize-file', rel)

export class FileArchive {
  constructor(private readonly deps: FileArchiveDeps) {}

  isSource(rel: string): boolean {
    return isInUserContent(rel) && !isSidecar(rel) && this.deps.vault.metadata.isAttachment(rel)
  }

  /** 这个文件能不能解析：第一版只支持能按文本读取的文件 */
  private async supported(rel: string, size: number): Promise<boolean> {
    if (!isTextFile(rel) || size > MAX_BYTES) return false
    // 扩展名是文本、内容却是二进制的，也不解析
    const handle = await fs.promises.open(this.deps.vault.abs(rel), 'r')
    try {
      const buf = Buffer.alloc(Math.min(size, 8192))
      await handle.read(buf, 0, buf.length, 0)
      return !buf.includes(0)
    } finally {
      await handle.close()
    }
  }

  summaries(rel: string): string[] {
    return this.deps.index.allPaths().filter(path => {
      const doc = this.deps.index.getDoc(path)
      return doc?.type === 'source-summary' && doc.sourcePath?.toLocaleLowerCase() === rel.toLocaleLowerCase()
    }).sort()
  }

  /** 只有显式导入才安排摘要，文件清单及配对从当前索引恢复。 */
  async handle(rel: string): Promise<void> {
    const stat = await fs.promises.stat(this.deps.vault.abs(rel)).catch(() => null)
    if (!stat?.isFile()) throw new JotError('NOT_FOUND', '原件不存在：' + rel)
    await this.deps.indexFile(rel)
    if (await this.supported(rel, stat.size) && !this.summaries(rel).length) this.deps.jobs.enqueuePath('summarize-file', rel)
    this.deps.changed()
  }

  /** 仅保护本次生成目标，不登记来源身份或版本；已有摘要后台保留。 */
  async summarize(rel: string, opts: { force?: boolean; signal?: AbortSignal; summaryPath?: string; onExecution?: (value: AiExecution) => void } = {}): Promise<string> {
    const { vault } = this.deps
    const root = vault.path, database = this.deps.state.raw
    const prepared = await this.deps.mutate(async () => {
      if (opts.signal?.aborted || !vault.isOpen || vault.path !== root || !this.deps.state.isOpen || this.deps.state.raw !== database) throw new JotError('CANCELLED', '摘要已取消或库已切换')
      const source = await vault.read({ path: rel })
      if (!await this.supported(rel, source.size ?? 0)) throw new JotError('UNSUPPORTED_FORMAT', '这种格式或大小暂不支持解析')
      const summaries = this.summaries(rel)
      if (summaries.length && !opts.force) return null
      if (summaries.length > 1 && !opts.summaryPath) throw new JotError('INVALID_INPUT', '存在多份摘要，请选择要替换的摘要')
      if (opts.summaryPath && !summaries.includes(opts.summaryPath)) throw new JotError('INVALID_INPUT', '所选摘要不属于当前原件')
      const target = opts.summaryPath ?? summaries[0]
      const previous = target ? await vault.read({ path: target }) : null
      const text = (isMarkdown(rel) ? parseDoc((await vault.readRaw(rel)).text).body : source.body).trim()
      if (!text) return null
      return { text, target, previous: previous?.hash, name: path.posix.basename(rel) }
    })
    if (!prepared) return '已有摘要或没有可用正文，已保留当前文件。'
    const task = await this.deps.executor.prepare('summarize-file', opts.signal, opts.onExecution)
    const result = await task.mapReduce(prepared.text, SummaryOutput, CONTRACT,
      part => '文件名：' + prepared.name + '\n原文材料：\n<<<\n' + part + '\n>>>',
      values => '文件名：' + prepared.name + '\n汇总以下全部分段结果，保留不同事实：\n' + JSON.stringify(values))
    const out = result.value, note = coverageNote(result.coverage), execution = task.execution
    await this.deps.mutate(async () => {
      if (opts.signal?.aborted || !vault.isOpen || vault.path !== root || !this.deps.state.isOpen || this.deps.state.raw !== database) throw new JotError('CANCELLED', '摘要已取消或库已切换')
      await vault.read({ path: rel })
      if (prepared.target) {
        const current = await vault.read({ path: prepared.target }).catch(() => null)
        if (!current || current.hash !== prepared.previous) throw new JotError('CONFLICT', '生成期间摘要已变化，已保留当前内容')
        if (current.sourcePath !== rel) throw new JotError('CONFLICT', '摘要来源路径已变化，请重新选择')
      } else if (this.summaries(rel).length) {
        throw new JotError('CONFLICT', '生成期间已出现摘要，请重新选择')
      }
      const generatedAt = localIso(this.deps.now())
      const target = prepared.target ?? await vault.freePath(monthlyPath(DIRS.wikiSources, generatedAt), prepared.name.replace(/\.[^.]+$/, ''), '.md')
      const sourceLink = path.posix.relative(path.posix.dirname(target), rel).split('/').map(encodeURIComponent).join('/')
      const body = renderSummary(out, note) + '\n## 来源\n\n[' + prepared.name.replace(/[[\]]/g, '') + '](' + sourceLink + ')\n'
      await vault.writeGenerated(target, {
        type: 'source-summary', generated_by: 'ai', generated_at: generatedAt,
        model: execution.model, skill: execution.skillId, reasoning: execution.reasoning, source: rel,
      }, body)
      await this.deps.indexFile(target)
      this.deps.changed()
    })
    return '摘要已保存。' + note
  }

  async reprocess(rel: string, force = false, summaryPath?: string): Promise<{ jobId: string }> {
    const doc = await this.deps.vault.read({ path: rel })
    if (!this.isSource(rel)) throw new JotError('INVALID_INPUT', '请选择附件原件')
    if (!await this.supported(rel, doc.size ?? 0)) throw new JotError('UNSUPPORTED_FORMAT', '这种格式或大小暂不支持解析')
    const summaries = this.summaries(rel)
    if (summaries.length > 1 && !summaryPath) throw new JotError('INVALID_INPUT', '存在多份摘要，请选择要替换的摘要')
    if (summaryPath && !summaries.includes(summaryPath)) throw new JotError('INVALID_INPUT', '所选摘要不属于当前原件')
    if (!force && summaries.length) throw new JotError('CONFLICT', '重新生成会替换现有摘要，请确认')
    const jobId = this.deps.jobs.enqueuePath('summarize-file', rel, { force: true, explicit: true, summaryPath })
    this.deps.changed()
    return { jobId }
  }

  /** 复制原件并保存可读用途属性。 */
  async import(paths: string[], toDir?: string): Promise<{ imported: string[]; skipped: { path: string; reason: string }[] }> {
    const imported: string[] = []
    const skipped: { path: string; reason: string }[] = []
    for (const p of paths) {
      try {
        const result = await this.deps.vault.importFile(p, toDir)
        // IPC 在 core.mutate 中执行，监听回调只会在原件角色落库后继续。
        await this.handle(result.path)
        imported.push(result.path)
      } catch (e) {
        skipped.push({ path: p, reason: e instanceof Error ? e.message : String(e) })
      }
    }
    return { imported, skipped }
  }

  /** 内容清单来自文件索引；状态库只补充现有任务的进度。 */
  catalog(): LibrarySource[] {
    const { index, jobs } = this.deps
    const docs = index.allDocs()
    const bySource = new Map<string, string[]>()
    for (const doc of docs) if (doc.type === 'source-summary' && doc.sourcePath) {
      const key = doc.sourcePath.toLocaleLowerCase()
      bySource.set(key, [...(bySource.get(key) ?? []), doc.path])
    }
    return docs.filter(doc => doc.type === 'file').map(doc => {
      const job = jobs.latestByKey(jobKey(doc.path))
      const summaryPaths = (bySource.get(doc.path.toLocaleLowerCase()) ?? []).sort()
      const summaryPath = summaryPaths[0]
      const supported = isTextFile(doc.path) && (doc.size ?? 0) <= MAX_BYTES
      const status: FileState = job?.state === 'running' ? 'processing' : job?.state === 'waiting-model' ? 'waiting-model'
        : job?.state === 'failed' ? 'failed' : job?.state === 'queued' ? 'queued' : summaryPath ? 'done' : supported ? 'unprocessed' : 'unsupported'
      return { path: doc.path, role: 'source' as const, classification: doc.classification,
        size: doc.size ?? 0, addedAt: doc.created, modified: doc.modified, missing: false,
        state: status, error: job?.error, summaryPath, summaryPaths, text: supported }
    })
  }

  list(page: { limit?: number; offset?: number } = {}): Paged<FileItem> {
    const items = this.catalog().sort((a, b) => b.addedAt.localeCompare(a.addedAt))
    return { total: items.length, items: items.slice(page.offset ?? 0, (page.offset ?? 0) + (page.limit ?? 200)) }
  }
}
