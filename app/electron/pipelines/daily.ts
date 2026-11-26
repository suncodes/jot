import { posix } from 'node:path'
import { z } from 'zod'
import { JotError } from '@shared/result'
import type { DayView, TimelineEntry } from '@shared/types'
import type { JobQueue } from '../jobs/queue'
import { coverageNote, type AiExecutor, type AiExecution } from '../agent/executor'
import type { StateStore } from '../state/state'
import type { IndexService } from '../index/index'
import { exists } from '../util/fs'
import { activityDay, localDay, localIso } from '../util/time'
import { DIRS } from '../vault/paths'
import type { VaultService } from '../vault/vault'
import { dateCandidates, overlaps } from '../content/time'

const lines = (max: number) => z.array(z.string()).nullish().transform(a => [...new Set((a ?? []).map(x => x.trim().slice(0, 200)).filter(Boolean))].slice(0, max))
export const DailyOutput = z.object({
  oneLine: z.string().transform(v => v.trim().slice(0, 80)),
  done: lines(12), highlights: lines(5), followUps: lines(5),
})
export type DailyOutput = z.infer<typeof DailyOutput>
const pathOf = (date: string) => DIRS.journal + '/' + date.slice(0, 4) + '/' + date + '.md'
const jobKey = (date: string) => 'daily:' + date
const link = (from: string, to: string, title: string) => '[' + title.replace(/[[\]\n]/g, '') + '](' + posix.relative(posix.dirname(from), to).split('/').map(encodeURIComponent).join('/') + ')'

export function renderDaily(out: DailyOutput, stats: DayView['stats']): string {
  const md = [out.oneLine, '']
  for (const [title, items] of [['做了什么', out.done], ['值得留意的想法', out.highlights], ['待跟进', out.followUps]] as const)
    if (items.length) md.push('## ' + title, '', ...items.map(i => '- ' + i), '')
  const counts = [stats.ideas && '随手记 ' + stats.ideas + ' 条', stats.logs && '补记 ' + stats.logs + ' 条',
    stats.files && '文件 ' + stats.files + ' 份', stats.notes && '笔记 ' + stats.notes + ' 篇', stats.conversations && 'AI 提问 ' + stats.conversations + ' 次'].filter(Boolean)
  md.push('## 今天的数字', '', '- ' + counts.join('，'))
  return md.join('\n') + '\n'
}
export interface DailyDeps {
  vault: VaultService; index: IndexService; state: StateStore; jobs: JobQueue; executor: AiExecutor
  now: () => Date; settings: () => { enabled: boolean; time: string }
  idle: () => Promise<void>
  mutate: <T>(operation: () => Promise<T>) => Promise<T>
}
/** 从当前文件属性和实际提问时间计算时间线，不保存内容事件或历史依据。 */
export class DailyPipeline {
  constructor(private readonly deps: DailyDeps) {}
  async entries(date: string): Promise<TimelineEntry[]> {
    const entries: TimelineEntry[] = []
    const docs = this.deps.index.allDocs()
    for (const doc of docs) {
      const path = doc.path
      const candidate = dateCandidates(doc).find(c => overlaps(c, date, date))
      if (!candidate) continue
      const current = await this.deps.vault.read({ path }).catch(() => null)
      if (!current) continue
      const kind = doc.type === 'idea' || doc.type === 'log' || doc.type === 'file' ? doc.type : 'note'
      const summaryPath = kind === 'file' ? docs.find(d => d.type === 'source-summary' && d.sourcePath === path)?.path : undefined
      entries.push({
        kind, basis: candidate.basis, time: candidate.time, end: candidate.end, created: doc.created,
        title: doc.title, path: summaryPath ?? path, sourcePath: path, classification: doc.classification,
        preview: kind === 'file' || kind === 'note' ? '文件有更新，具体变化未确认' : current.body.trim().slice(0, 300),
      })
    }
    const messages = this.deps.state.raw.prepare("SELECT id,conversation_id,text,created_at FROM messages WHERE role='user' ORDER BY created_at,id")
      .all() as { id: string; conversation_id: string; text: string; created_at: string }[]
    for (const row of messages) if (activityDay(row.created_at) === date) entries.push({
      kind: 'conversation', basis: 'question', conversationId: row.conversation_id, messageId: row.id,
      time: row.created_at, created: row.created_at, title: row.text.replace(/\s+/g, ' ').slice(0, 100), preview: row.text.slice(0, 300),
    })
    return entries.sort((a, b) => a.time.localeCompare(b.time) || (a.sourcePath ?? a.messageId ?? '').localeCompare(b.sourcePath ?? b.messageId ?? ''))
  }
  private stats(entries: TimelineEntry[]): DayView['stats'] {
    const n = (kind: TimelineEntry['kind']) => entries.filter(e => e.kind === kind).length
    return { ideas: n('idea'), logs: n('log'), files: n('file'), notes: n('note'), conversations: n('conversation') }
  }
  async view(date: string): Promise<DayView> {
    const entries = await this.entries(date)
    const view: DayView = { date, entries, stats: this.stats(entries) }
    const path = pathOf(date)
    if (await exists(this.deps.vault.abs(path))) {
      const doc = await this.deps.vault.read({ path })
      view.daily = { path, body: doc.body, generatedAt: typeof doc.properties?.generated_at === 'string' ? doc.properties.generated_at : doc.created }
    }
    const job = this.deps.jobs.latestByKey(jobKey(date))
    if (job && !['done', 'cancelled'].includes(job.state)) view.dailyJob = { state: job.state, error: job.error }
    return view
  }
  async run(date: string, opts: { force?: boolean; signal?: AbortSignal; onExecution?: (value: AiExecution) => void } = {}): Promise<'written' | 'empty' | 'kept'> {
    const { vault, executor } = this.deps
    const database = this.deps.state.raw, root = vault.path
    await this.deps.idle()
    const path = pathOf(date)
    const prepared = await this.deps.mutate(async () => {
      if (opts.signal?.aborted || !vault.isOpen || vault.path !== root || this.deps.state.raw !== database) throw new JotError('CANCELLED', '日总结生成已取消或库已切换')
      const previous = await exists(vault.abs(path)) ? await vault.read({ path }) : null
      if (previous && !opts.force) return 'kept' as const
      const entries = await this.entries(date)
      if (!entries.length) return 'empty' as const
      const blocks: { start: number; end: number; header: string }[] = []
      let text = ''
      for (const entry of entries) {
        if (entry.kind === 'file' || entry.kind === 'note') continue
        const source = entry.kind === 'conversation'
          ? (database.prepare("SELECT text FROM messages WHERE id=? AND role='user'").get(entry.messageId!) as { text: string }).text
          : (await vault.read({ path: entry.sourcePath! })).body.trim()
        if (!source) continue
        if (text) text += '\n\n'
        const start = text.length
        text += source
        blocks.push({ start, end: text.length, header: '[' + entry.time + '] ' + entry.title + '\n'
          + (entry.kind === 'conversation' ? '用户讨论（不代表完成）：' : '明确记录：') })
      }
      return { entries, stats: this.stats(entries), text, blocks, previous: previous?.hash }
    })
    if (typeof prepared === 'string') return prepared
    const task = prepared.text ? await executor.prepare('daily', opts.signal, opts.onExecution) : undefined
    const contract = '仅返回JSON：{"oneLine":"一句话","done":["明确事项"],"highlights":["想法"],"followUps":["待跟进"]}。没有则空数组。'
    const result = task ? await task.mapReduce(prepared.text, DailyOutput, contract,
      (part, offset) => '日期：' + date + '\n明确记录／讨论材料（当前正文）：\n<<<\n'
        + prepared.blocks.filter(block => block.end > offset && block.start < offset + part.length)
          .map(block => block.header + prepared.text.slice(Math.max(block.start, offset), Math.min(block.end, offset + part.length))).join('\n\n') + '\n>>>',
      values => '日期：' + date + '\n汇总以下全部分段结果，保留明确事项与讨论的区别：\n' + JSON.stringify(values)) : undefined
    const out = result?.value ?? DailyOutput.parse({ oneLine: '今天有资料更新，具体变化未确认。' })
    const execution = task?.execution
    let body = renderDaily(out, prepared.stats)
    const updates = prepared.entries.filter(e => e.kind === 'file' || e.kind === 'note')
    if (updates.length) body += '\n## 有更新的资料\n\n' + updates.map(e => '- ' + link(path, e.sourcePath!, e.title) + '：具体变化未确认').join('\n') + '\n'
    const sources = prepared.entries.filter(e => e.sourcePath)
    if (sources.length) body += '\n## 来源\n\n' + sources.map(e => '- ' + link(path, e.sourcePath!, e.title)).join('\n') + '\n'
    const note = result && coverageNote(result.coverage)
    if (note) body += '\n> ' + note + ' 来源链接和数字仍包含当天全部记录。\n'
    return this.deps.mutate(async () => {
      if (opts.signal?.aborted || !vault.isOpen || vault.path !== root || this.deps.state.raw !== database) throw new JotError('CANCELLED', '日总结生成已取消')
      const current = await exists(vault.abs(path)) ? await vault.read({ path }) : null
      if (current?.hash !== prepared.previous) throw new JotError('CONFLICT', '生成期间日总结已变化，已保留当前内容，请重新生成')
      await vault.writeGenerated(path, { type: 'daily', date, generated_by: execution ? 'ai' : 'system', generated_at: localIso(this.deps.now()), ...(execution ? { model: execution.model, skill: execution.skillId, reasoning: execution.reasoning } : {}) }, body)
      return 'written' as const
    })
  }
  async request(date: string, force = false): Promise<{ jobId: string }> {
    const view = await this.view(date)
    if (view.daily && !force) throw new JotError('CONFLICT', '重新生成会替换现有日总结，请确认')
    if (!view.entries.length) throw new JotError('INVALID_INPUT', '这一天没有可用记录')
    const previous = this.deps.jobs.latestByKey(jobKey(date))
    if (previous && ['queued', 'running', 'waiting-model'].includes(previous.state)) return { jobId: previous.jobId }
    if (previous?.state === 'failed') this.deps.jobs.cancel(previous.jobId)
    return { jobId: this.deps.jobs.enqueue('daily', { date, force: true }, { dedupeKey: jobKey(date), target: date }) }
  }
  async tick(): Promise<string[]> {
    const { enabled, time } = this.deps.settings()
    if (!enabled) return []
    const now = this.deps.now()
    const [h = 21, m = 30] = time.split(':').map(Number)
    const queued: string[] = []
    for (let i = 7; i >= 0; i--) {
      const date = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i))
      if (!i && now.getHours() * 60 + now.getMinutes() < h * 60 + m) continue
      if (await exists(this.deps.vault.abs(pathOf(date))) || this.deps.jobs.latestByKey(jobKey(date))?.state === 'failed') continue
      if (!(await this.entries(date)).length) continue
      this.deps.jobs.enqueue('daily', { date }, { dedupeKey: jobKey(date), target: date })
      queued.push(date)
    }
    return queued
  }
  daysWithRecords(month: string): string[] {
    const [year, monthNum] = month.split('-').map(Number)
    const days = new Set<string>()
    const last = new Date(year!, monthNum!, 0).getDate()
    for (const doc of this.deps.index.allDocs()) {
      for (const candidate of dateCandidates(doc)) {
        for (let d = 1; d <= last; d++) {
          const date = month + '-' + String(d).padStart(2, '0')
          if (overlaps(candidate, date, date)) days.add(date)
        }
      }
    }
    for (const row of this.deps.state.raw.prepare("SELECT created_at FROM messages WHERE role='user'").all() as { created_at: string }[]) {
      const date = activityDay(row.created_at)
      if (date.startsWith(month + '-')) days.add(date)
    }
    return [...days].sort()
  }
}
