import { z } from 'zod'
import { JotError } from '@shared/result'
import { contentArea } from '@shared/storage'
import type { SuggestionKind } from '@shared/pending'
import type { ClassificationPatch, DocMeta, InboxItem, JobInfo, Paged, Ref, TermInfo } from '@shared/types'
import type { IndexService } from '../index/index'
import type { ContentService } from '../content/scope'
import { coverageNote, type AiExecutor, type AiExecution } from '../agent/executor'
import type { StateStore } from '../state/state'
import type { JobQueue } from '../jobs/queue'
import type { VaultService } from '../vault/vault'

const names = (max: number) => z.array(z.string()).nullish()
  .transform((a): string[] | null => [...new Set((a ?? []).map(x => x.trim().replace(/^#/, '').slice(0, 40)).filter(Boolean))].slice(0, max)).catch(null)
export const ClassifyOutput = z.object({
  directoryPath: z.string().trim().min(1).max(1000).nullish().transform((v): string | null | undefined => v ?? null).catch(undefined),
  tags: names(5), place: z.string().nullish().transform((v): string | null | undefined => v?.trim().slice(0, 40) || null).catch(undefined), people: names(8),
  confidence: z.number().min(0).max(1), reason: z.string().nullish().transform(v => (v ?? '').slice(0, 100)),
}).strict()
export type ClassifyOutput = z.infer<typeof ClassifyOutput>
const CONTRACT = '仅返回JSON：{"directoryPath":"已有content目录或null","tags":[],"place":null,"people":[],"confidence":0.0,"reason":"一句话依据"}；目录和属性独立，无法确定时留空。'
export function extractHashtags(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/(?:^|[\s，。；、（(])#([^\s#，。；、！？,.!?()（）]{1,20})/g)) if (m[1]) out.add(m[1])
  return [...out]
}
export interface ClassifyDeps {
  vault: VaultService; index: IndexService; state: StateStore; executor: AiExecutor
  content: ContentService; jobs: JobQueue
  mutate: <T>(operation: () => Promise<T>) => Promise<T>
  moved: (changes: import('@shared/files').PathChange[]) => void | Promise<void>
}
const equivalent = (a: unknown, b: unknown) => JSON.stringify(Array.isArray(a) ? [...a].sort() : a ?? '') === JSON.stringify(Array.isArray(b) ? [...b].sort() : b ?? '')
const unresolved = (job: JobInfo) => ['queued', 'running', 'waiting-model', 'failed'].includes(job.state)
export interface AnalysisResult { state: 'suggested' | 'skipped'; note: string }

export class ClassifyPipeline {
  constructor(private readonly deps: ClassifyDeps) {}
  private async target(ref: Ref): Promise<string> {
    const doc = await this.deps.vault.read(ref)
    return doc.type === 'source-summary' && doc.sourcePath ? doc.sourcePath : doc.path
  }
  /** 仅已发起且未解决的分析进入属性待处理，不以属性为空制造事项。 */
  pendingPaths(): string[] {
    return [...new Set([...this.deps.state.suggestionPaths(),
      ...[...this.deps.jobs.latestForPaths('classify').values()].filter(unresolved).flatMap(job => job.target ? [job.target] : [])])].filter(rel => contentArea(rel) !== null)
  }
  /** 模型只产出独立建议；文件属性仅在用户确认时写入。 */
  async run(rel: string, opts: { force?: boolean; signal?: AbortSignal; onExecution?: (value: AiExecution) => void } = {}): Promise<AnalysisResult> {
    const { vault, state, content, index } = this.deps
    const database = state.raw, root = vault.path
    const check = () => {
      if (opts.signal?.aborted || !vault.isOpen || vault.path !== root || !state.isOpen || state.raw !== database) throw new JotError('CANCELLED', '分析已取消或库已切换')
    }
    const prepared = await this.deps.mutate(async () => {
      check()
      const target = await this.target({ path: rel })
      if (!contentArea(target)) throw new JotError('INVALID_INPUT', '只分析灵感、待归档资料或内容库中的文件')
      const initial = await vault.read({ path: target })
      if (!opts.force && state.getSuggestions(target).length) return null
      const summaries = initial.type === 'file'
        ? index.allDocs().filter(doc => doc.type === 'source-summary' && doc.sourcePath?.toLocaleLowerCase() === target.toLocaleLowerCase()).map(doc => doc.path) : []
      const input = await vault.read({ path: rel !== target ? rel : summaries[0] ?? target })
      if (!input.editable || (input.size ?? 0) > 10 * 1024 * 1024) throw new JotError('INVALID_INPUT', '此格式或大小暂不支持正文分析，请手动选择目录或设置属性。')
      if (!input.body.trim() || input.body.includes('\u0000')) throw new JotError('INVALID_INPUT', '没有可分析的正文，请补充内容，或手动选择目录和设置属性。')
      return { target, initial, inputPath: input.path, text: input.body.trim(),
        directories: contentArea(target) === 'inbox' ? content.directories(undefined, true).map(d => d.path) : [],
        terms: { tags: this.terms('tag').map(term => term.name), people: this.terms('person').map(term => term.name), places: this.terms('place').map(term => term.name) } }
    })
    if (!prepared) return { state: 'skipped', note: '已有待确认建议，可确认、忽略或主动重新分析。' }
    const task = await this.deps.executor.prepare('classify', opts.signal, opts.onExecution)
    check()
    const { target } = prepared
    const directories: string[] = [], vocabulary = { tags: [] as string[], people: [] as string[], places: [] as string[] }
    const context = () => '当前位置：' + target + '\n可推荐目录：\n' + directories.join('\n') + '\n当前属性：' + JSON.stringify(prepared.initial.classification)
      + '\n已有词表：' + JSON.stringify(vocabulary) + '\n'
    // 程序列明实际候选范围；保留主要预算读取正文，不悄悄沿用固定条数截断。
    for (const directory of prepared.directories) {
      directories.push(directory)
      if (!task.fits(context(), CONTRACT, 0.45)) { directories.pop(); break }
    }
    for (const field of ['tags', 'people', 'places'] as const) for (const term of prepared.terms[field]) {
      vocabulary[field].push(term)
      if (!task.fits(context(), CONTRACT, 0.5)) { vocabulary[field].pop(); break }
    }
    const analysis = await task.mapReduce(prepared.text, ClassifyOutput, CONTRACT,
      part => context() + '待分析内容：\n<<<\n' + part + '\n>>>',
      values => context() + '综合以下分段的目录与属性建议：\n' + JSON.stringify(values))
    const out = analysis.value
    const notes = [coverageNote(analysis.coverage), ...(prepared.inputPath !== target ? ['本次依据摘要：' + prepared.inputPath + '。'] : [])]
    if (directories.length < prepared.directories.length) notes.push('本次比较 ' + directories.length + ' / ' + prepared.directories.length + ' 个目录，其余可手动选择。')
    const selectedTerms = Object.values(vocabulary).reduce((sum, terms) => sum + terms.length, 0)
    const totalTerms = Object.values(prepared.terms).reduce((sum, terms) => sum + terms.length, 0)
    if (selectedTerms < totalTerms) notes.push('本次参考 ' + selectedTerms + ' / ' + totalTerms + ' 个既有词条。')
    const result = await this.deps.mutate(async () => {
      check()
      const current = await vault.read({ path: target })
      // 分项替换有效结果；格式错误的字段保留旧建议，不能冒充明确空值。
      const previous = state.getSuggestion(target, 'properties')
      const invalid: string[] = []
      const directoryPath = out.directoryPath
      if (directoryPath === undefined && contentArea(target) === 'inbox') invalid.push('目录')
      const directoryValid = contentArea(target) === 'inbox' && !!directoryPath && directories.includes(directoryPath)
        && content.directories(undefined, true).some(d => d.path === directoryPath)
      if (directoryValid) state.setSuggestion(target, { kind: 'directory', directoryPath: directoryPath!, confidence: out.confidence, reason: out.reason })
      else if (directoryPath !== undefined) state.removeSuggestion(target, 'directory')
      const proposed: ClassificationPatch = {}
      for (const field of ['tags', 'people'] as const) {
        if (out[field] === null) {
          invalid.push(field === 'tags' ? '标签' : '人物')
          if (previous?.kind === 'properties' && previous.properties[field]) proposed[field] = previous.properties[field]
          continue
        }
        const value = [...new Set([...current.classification[field], ...out[field]!])]
        if (!equivalent(current.classification[field], value)) proposed[field] = value
      }
      if (out.place === undefined) {
        invalid.push('地点')
        if (previous?.kind === 'properties' && previous.properties.place !== undefined) proposed.place = previous.properties.place
      } else if (out.place && out.place !== current.classification.place) proposed.place = out.place
      if (Object.keys(proposed).length) state.setSuggestion(target, { kind: 'properties', properties: proposed, confidence: out.confidence, reason: out.reason })
      else state.removeSuggestion(target, 'properties')
      const notes = [
        ...(contentArea(target) === 'inbox' && !directoryValid ? [directoryPath ? '推荐目录不可用，请手动选择目录。' : '未推荐存放目录，可手动选择或暂缓。'] : []),
        ...(!Object.keys(proposed).length ? ['没有需要补充的属性，空属性无需处理。'] : []),
        ...(!state.getSuggestions(target).length && out.reason ? [out.reason] : []),
      ]
      return { state: state.getSuggestions(target).length ? 'suggested' as const : 'skipped' as const, note: notes.join(' '), invalid }
    })
    const propertyErrors = result.invalid.filter(field => field !== '目录')
    if (propertyErrors.length) throw new JotError('INVALID_INPUT', result.invalid.join('、') + '返回格式无效，已保留有效建议及原有未完成建议，请重试或手动处理。')
    if (result.invalid.includes('目录')) result.note = '目录返回格式无效，可手动选择；已有有效建议保留。 ' + result.note
    return { state: result.state, note: [result.note, ...notes].filter(Boolean).join(' ') }
  }
  async setByUser(ref: Ref, input: ClassificationPatch): Promise<DocMeta> {
    const { vault, state } = this.deps
    const target = await this.target(ref)
    const patch: Record<string, unknown> = {}
    for (const key of ['tags', 'place', 'people'] as const) if (input[key] !== undefined) patch[key] = input[key]
    const meta = await vault.patchFrontmatter({ path: target }, patch, 'user')
    state.confirmTerms('tag', input.tags ?? []); state.confirmTerms('person', input.people ?? [])
    if (input.place) state.confirmTerms('place', [input.place])
    state.discardPropertySuggestions(target, Object.keys(input))
    return meta
  }
  async accept(ref: Ref, kind: SuggestionKind, toDir?: string): Promise<DocMeta> {
    const target = await this.target(ref)
    const suggestion = this.deps.state.getSuggestion(target, kind)
    if (kind === 'properties') {
      if (suggestion?.kind !== 'properties') throw new JotError('NOT_FOUND', '这项内容没有待确认的属性建议')
      const current = await this.deps.vault.read({ path: target })
      const patch = { ...suggestion.properties }
      for (const field of ['tags', 'people'] as const) if (patch[field]) patch[field] = [...new Set([...current.classification[field], ...patch[field]])]
      return this.setByUser({ path: target }, patch)
    }
    if (contentArea(target) !== 'inbox') throw new JotError('INVALID_INPUT', '文件已不在收件箱，请重新选择整理目标')
    const directoryPath = toDir ?? (suggestion?.kind === 'directory' ? suggestion.directoryPath : undefined)
    if (!directoryPath || !this.deps.content.directories(undefined, true).some(d => d.path === directoryPath)) throw new JotError('NOT_FOUND', '请选择已有的内容库文件夹')
    const moved = await this.deps.vault.move({ path: target }, directoryPath)
    await this.deps.moved([{ from: target, to: moved.path }])
    this.deps.state.removeSuggestion(moved.path, 'directory')
    return moved
  }
  async skip(ref: Ref, kind: SuggestionKind): Promise<DocMeta> {
    const target = await this.target(ref)
    if (kind === 'properties') {
      const job = this.deps.jobs.latestForPaths('classify').get(target.toLocaleLowerCase())
      if (job && unresolved(job)) this.deps.jobs.cancel(job.jobId)
    }
    // 目录建议可暂缓，但仍由 inbox 路径产生目录待处理。
    this.deps.state.removeSuggestion(target, kind)
    return this.deps.vault.read({ path: target })
  }
  inbox(page: { limit?: number; offset?: number }): Paged<InboxItem> {
    const r = this.deps.content.library({ pending: true, limit: page.limit ?? 50, offset: page.offset })
    const analysis = this.deps.jobs.latestForPaths('classify')
    return { total: r.total, items: r.items.flatMap(item => {
      const doc = this.deps.index.getDoc(item.path)
      if (!doc) return []
      const suggestions = this.deps.state.getSuggestions(item.path).filter(s => s.kind !== 'directory' || contentArea(item.path) === 'inbox')
      const job = analysis.get(item.path.toLocaleLowerCase())
      const reasons: SuggestionKind[] = [...(contentArea(item.path) === 'inbox' ? ['directory' as const] : []),
        ...(suggestions.some(s => s.kind === 'properties') || job && unresolved(job) ? ['properties' as const] : [])]
      return [{ doc, preview: item.preview, reasons, suggestions, analysis: job }]
    }) }
  }
  terms(kind: 'tag' | 'place' | 'person'): TermInfo[] {
    const vocabulary = this.deps.state.vocabulary(kind)
    const counts = new Map(this.deps.index.termCounts(kind).map(({ name, count }) => [name, count]))
    for (const [name, state] of vocabulary) {
      if (state === 'preset' && !counts.has(name)) counts.set(name, 0)
    }
    return [...counts].map<TermInfo>(([name, count]) => ({
      name, count, state: vocabulary.has(name) || count >= 3 ? 'official' : 'candidate',
    })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }
}
