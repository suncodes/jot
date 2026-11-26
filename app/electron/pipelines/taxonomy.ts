import { ulid } from 'ulid'
import { z } from 'zod'
import { JotError } from '@shared/result'
import type { SynonymGroup, TermKind } from '@shared/types'
import type { IndexService } from '../index/index'
import type { JobQueue } from '../jobs/queue'
import { coverageNote, TASK_LIMITS, type AiExecutor, type AiExecution } from '../agent/executor'
import type { StateStore } from '../state/state'
import type { BatchResult } from '@shared/files'
import type { VaultService } from '../vault/vault'

// 标签、人物和地点管理：回读并调整当前文件属性。
// 见 docs/user-guide.md。

export const SynonymOutput = z.object({
  groups: z
    .array(z.object({ names: z.array(z.string()).min(2).max(8), suggested: z.string().min(1), reason: z.string().nullish().transform((v) => (v ?? '').slice(0, 80)) }))
    .nullish()
    .transform((a) => a ?? []),
})

const KIND_LABEL: Record<TermKind, string> = { tag: '标签', place: '地点', person: '人物' }

const CONTRACT = '仅返回JSON：{"groups":[{"names":["给定名称甲","给定名称乙"],"suggested":"names中的名称","reason":"同义依据"}]}；没有确定同义返回空groups。'

export interface TaxonomyDeps {
  vault: VaultService
  index: IndexService
  state: StateStore
  jobs: JobQueue
  executor: AiExecutor
  mutate: <T>(operation: () => Promise<T>) => Promise<T>
  terms: (kind: 'tag' | 'place' | 'person') => { name: string; count: number }[]
  idle: () => Promise<void>
  changed: () => void
}

export class TaxonomyService {
  constructor(private readonly deps: TaxonomyDeps) {}

  private check(name: string): string {
    const value = name.trim()
    if (!value) throw new JotError('INVALID_INPUT', '名称不能为空')
    return value
  }

  /** 候选来自索引，逐文件回读后修改。失败返回路径，已成功的文件无需回滚。 */
  private async replace(kind: TermKind, from: string[], into?: string): Promise<BatchResult> {
    await this.deps.idle()
    const names = new Set(from)
    const paths = [...new Set(from.flatMap(name => this.deps.index.pathsUsing(kind, name, kind === 'tag')))]
    const result: BatchResult = { affected: 0, updated: [], failed: [] }
    for (const path of paths) {
      try {
        const doc = await this.deps.vault.read({ path })
        if (doc.invalidProperties) throw new JotError('INVALID_INPUT', '请先修正文件属性')
        if (doc.type === 'source-summary' && doc.sourcePath && this.deps.index.getDoc(doc.sourcePath)) continue
        const c = doc.classification
        const swap = (value: string) => {
          const source = from.find(name => value === name || kind === 'tag' && value.startsWith(name + '/'))
          return source ? into ? into + value.slice(source.length) : null : value
        }
        const list = (values: string[]) => [...new Set(values.map(swap).filter((v): v is string => v !== null))]
        const patch = kind === 'tag' ? { tags: list(c.tags) } : kind === 'person' ? { people: list(c.people) }
          : { place: c.place && names.has(c.place) ? into ?? null : c.place ?? null }
        const changed = kind === 'tag' ? JSON.stringify(patch.tags) !== JSON.stringify(c.tags)
          : kind === 'person' ? JSON.stringify(patch.people) !== JSON.stringify(c.people) : patch.place !== (c.place ?? null)
        if (!changed) continue
        await this.deps.vault.patchFrontmatter({ path }, patch, 'user')
        this.deps.state.discardPropertySuggestions(path, [kind === 'tag' ? 'tags' : kind === 'person' ? 'people' : 'place'])
        result.updated.push(path)
      } catch (error) { result.failed.push({ path, message: error instanceof Error ? error.message : String(error) }) }
    }
    result.affected = result.updated.length
    for (const name of from) {
      if (!result.failed.length) this.deps.state.renameTerm(kind, name, into ?? '')
      else if (into) this.deps.state.confirmTerms(kind, [into])
    }
    this.dropSuggestionsFor(kind, from)
    await this.deps.idle()
    this.deps.changed()
    return result
  }
  create(kind: TermKind, name: string): void {
    const value = this.check(name)
    if (this.deps.terms(kind).some(term => term.name === value)) throw new JotError('CONFLICT', '已有同名词条')
    this.deps.state.confirmTerms(kind, [value], 'preset')
    this.deps.changed()
  }

  rename(kind: TermKind, from: string, to: string): Promise<BatchResult> {
    const source = this.check(from), target = this.check(to)
    return this.replace(kind, source === target ? [] : [source], target)
  }
  merge(kind: TermKind, from: string[], into: string): Promise<BatchResult> {
    const target = this.check(into)
    return this.replace(kind, [...new Set(from.map(s => this.check(s)).filter(s => s !== target))], target)
  }
  remove(kind: TermKind, name: string, into?: string): Promise<BatchResult> {
    const source = this.check(name)
    const target = into ? this.check(into) : undefined
    if (source === target) throw new JotError('INVALID_INPUT', '迁移目标不能是自身')
    return this.replace(kind, [source], target)
  }

  // ---------- 检查同义 ----------

  private names(kind: TermKind): { name: string; count: number }[] {
    return this.deps.terms(kind)
  }

  /** 让模型找出疑似同义的名称。结果存下来，等你逐条确认。 */
  async findSynonyms(kind: TermKind, opts: { signal?: AbortSignal; onExecution?: (value: AiExecution) => void } = {}): Promise<{ count: number; note: string }> {
    const { state, vault } = this.deps
    const database = state.raw, root = vault.path
    const check = () => {
      if (opts.signal?.aborted || !vault.isOpen || vault.path !== root || !state.isOpen || state.raw !== database) throw new JotError('CANCELLED', '同义分析已取消或库已切换')
    }
    await this.deps.idle()
    const terms = await this.deps.mutate(async () => { check(); return this.names(kind) })
    if (terms.length < 2) {
      await this.deps.mutate(async () => { check(); state.replaceSynonyms(kind, [], ulid); this.deps.changed() })
      return { count: 0, note: '不足两个词条，无需同义分析。' }
    }
    const task = await this.deps.executor.prepare('find-synonyms', opts.signal, opts.onExecution)
    const input = (items: typeof terms) => '类别：' + KIND_LABEL[kind] + '\n名称和使用次数：\n' + items.map(term => term.name + '（' + term.count + '）').join('\n')
    const batches = task.fits(input(terms), CONTRACT) ? [terms] : task.batches(terms, input, CONTRACT, 0.45, TASK_LIMITS.termBatches)
    const covered = batches.flat()
    const candidates: z.infer<typeof SynonymOutput>['groups'] = []
    // 分批之间也比较，避免只在相邻词条中找同义；最多8批/36次，范围明确。
    for (let i = 0; i < batches.length; i++) for (let j = i; j < batches.length; j++) {
      const current = i === j ? batches[i]! : [...batches[i]!, ...batches[j]!]
      if (current.length < 2) continue
      const out = await task.run(input(current), SynonymOutput, CONTRACT)
      const known = new Set(current.map(term => term.name))
      for (const group of out.groups) {
        const names = [...new Set(group.names.map(name => name.trim()))].filter(name => known.has(name))
        if (names.length >= 2) candidates.push({ ...group, names })
      }
    }
    const note = coverageNote({ processed: covered.length, total: terms.length, unit: 'terms', segmented: batches.length > 1 })
    return this.deps.mutate(async () => {
      check()
      const known = new Set(this.names(kind).map(term => term.name)), used = new Set<string>()
      const groups: typeof candidates = []
      for (const group of candidates) {
        const names = group.names.filter(name => known.has(name) && !used.has(name))
        if (names.length < 2) continue
        names.forEach(name => used.add(name))
        groups.push({ names, suggested: names.includes(group.suggested.trim()) ? group.suggested.trim() : names[0]!, reason: group.reason })
      }
      state.replaceSynonyms(kind, groups, ulid)
      this.deps.changed()
      return { count: groups.length, note: '发现 ' + groups.length + ' 组待确认同义建议。' + note }
    })
  }
  requestSynonyms(kind: TermKind): { jobId: string } {
    return { jobId: this.deps.jobs.enqueue('find-synonyms', { kind }, { dedupeKey: `synonyms:${kind}`, target: KIND_LABEL[kind] }) }
  }

  synonyms(): SynonymGroup[] {
    return this.deps.state.synonyms() as SynonymGroup[]
  }

  dismiss(id: string): void {
    this.deps.state.removeSynonym(id)
    this.deps.changed()
  }

  /** 合并之后，涉及这些名称的同义建议就不用再留着了 */
  dropSuggestionsFor(kind: TermKind, names: string[]): void {
    const { state } = this.deps
    for (const g of state.synonyms()) if (g.kind === kind && g.names.some((n) => names.includes(n))) state.removeSynonym(g.id)
  }
}
