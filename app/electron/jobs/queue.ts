import { ulid } from 'ulid'
import { JotError } from '@shared/result'
import type { AiExecution, JobInfo, JobState, JobsSummary, JobType, Paged } from '@shared/types'
import type { PathChange } from '@shared/files'
import { mappedPath } from '../vault/links'
import { normalizeRel } from '../vault/paths'
import type { StateStore } from '../state/state'

// 后台任务队列：持久化在状态库里，软件重启后继续。一次只跑一个任务。
// 见 docs/architecture.md。

export interface JobContext {
  jobId: string
  signal: AbortSignal
  recordExecution: (execution: AiExecution) => void
}
export type JobHandler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<void | string>

interface JobRow {
  id: string; type: JobType; payload: string; dedupe_key: string | null; state: JobState; attempts: number; model_waits: number
  next_run_at: number; error: string | null; target: string | null
}

/** 普通错误的重试间隔；三次之后标记为失败 */
const RETRY_MS = [15_000, 60_000, 300_000]
/** 模型不可用时的重试间隔，不计入失败次数 */
const MODEL_WAIT_MS = [30_000, 60_000, 120_000, 300_000]

const toInfo = (r: JobRow): JobInfo => ({
  jobId: r.id, type: r.type, target: r.target ?? undefined, state: r.state, attempts: r.attempts,
  nextRunAt: r.state === 'queued' || r.state === 'waiting-model' ? new Date(r.next_run_at).toISOString() : undefined,
  error: r.error ?? undefined,
  execution: (JSON.parse(r.payload) as { execution?: AiExecution }).execution,
  note: r.state === 'done' ? (JSON.parse(r.payload) as { resultNote?: string }).resultNote : undefined,
})

export class JobQueue {
  private handlers = new Map<JobType, JobHandler>()
  private listeners = new Set<(summary: JobSummary, job?: JobInfo) => void>()
  private timer: NodeJS.Timeout | null = null
  private running: { id: string; abort: AbortController } | null = null
  private loop: Promise<void> = Promise.resolve()
  private started = false

  constructor(
    private readonly state: StateStore,
    private readonly now: () => number = Date.now,
  ) {}

  private get db() {
    return this.state.raw
  }

  register(type: JobType, handler: JobHandler): void {
    this.handlers.set(type, handler)
  }

  onUpdate(listener: (summary: JobSummary, job?: JobInfo) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 未完成目标及整理结果跟随已知移动；在途模型任务取消，由用户按新路径重发。 */
  moveTargets(changes: PathChange[]): void {
    const rows = this.db.prepare("SELECT * FROM jobs WHERE type IN ('classify','summarize-file') AND (type='classify' OR state IN ('queued','running','waiting-model','failed'))").all() as JobRow[]
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as { path: string; summaryPath?: string }
      const target = mappedPath(payload.path, changes)
      const summaryPath = payload.summaryPath ? mappedPath(payload.summaryPath, changes) : undefined
      if (target === payload.path && summaryPath === payload.summaryPath) continue
      if (row.state === 'running') this.cancel(row.id)
      this.db.prepare('UPDATE jobs SET payload=?,target=?,dedupe_key=? WHERE id=?')
        .run(JSON.stringify({ ...payload, path: target, ...(summaryPath ? { summaryPath } : {}) }), target, pathJobKey(row.type, target), row.id)
      this.changed(row.id)
    }
  }

  cancelTargets(paths: string[]): void {
    for (const row of this.db.prepare("SELECT * FROM jobs WHERE state IN ('queued','running','waiting-model','failed') AND type IN ('classify','summarize-file')").all() as JobRow[]) {
      if (row.target && paths.some(rel => row.target!.toLocaleLowerCase() === rel.toLocaleLowerCase() || row.target!.toLocaleLowerCase().startsWith(rel.toLocaleLowerCase() + '/'))) this.cancel(row.id)
    }
  }

  enqueuePath(type: 'classify' | 'summarize-file', rel: string, options: { force?: boolean; explicit?: boolean; summaryPath?: string } = {}): string {
    const target = normalizeRel(rel)
    const key = pathJobKey(type, target)
    const previous = this.latestByKey(key)
    if (previous?.state === 'failed' && !options.explicit) return previous.jobId
    if (options.explicit && previous?.state === 'running') throw new JotError('CONFLICT', '文件正在处理，请等待完成或先取消任务')
    if (options.explicit && previous && ['failed', 'queued', 'waiting-model'].includes(previous.state)) this.cancel(previous.jobId)
    return this.enqueue(type, { path: target, force: options.force === true, ...(options.summaryPath ? { summaryPath: options.summaryPath } : {}) }, { dedupeKey: key, target })
  }

  /** 库打开后调用：上次没跑完的任务重新排队，然后开始执行 */
  start(): void {
    this.db.prepare("UPDATE jobs SET state = 'queued', next_run_at = ? WHERE state = 'running'").run(this.now())
    this.pruneFinished()
    this.started = true
    this.schedule()
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.running?.abort.abort()
    await this.loop.catch(() => {})
  }

  /** 排一个任务。dedupeKey 相同且还没结束的任务不重复排。 */
  enqueue(type: JobType, payload: Record<string, unknown>, opts: { dedupeKey?: string; runAt?: number; target?: string } = {}): string {
    if (opts.dedupeKey) {
      const existing = this.db.prepare("SELECT id FROM jobs WHERE dedupe_key = ? AND state IN ('queued', 'running', 'waiting-model')").get(opts.dedupeKey) as { id: string } | undefined
      if (existing) return existing.id
    }
    const id = ulid()
    const now = this.now()
    this.db
      .prepare("INSERT INTO jobs(id, type, payload, dedupe_key, state, next_run_at, target, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)")
      .run(id, type, JSON.stringify(payload), opts.dedupeKey ?? null, opts.runAt ?? now, opts.target ?? null, now, now)
    this.changed(id)
    this.schedule()
    return id
  }

  /** 某个去重键下最近的一个任务 */
  latestByKey(dedupeKey: string): JobInfo | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE dedupe_key = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(dedupeKey) as JobRow | undefined
    return row ? toInfo(row) : null
  }

  /** 每个当前目标只取最近任务，供待处理一次合并进度；不逐文件查任务表。 */
  latestForPaths(type: JobType): Map<string, JobInfo> {
    const rows = this.db.prepare('SELECT * FROM jobs WHERE type=? AND target IS NOT NULL ORDER BY created_at DESC,id DESC').all(type) as JobRow[]
    const result = new Map<string, JobInfo>()
    for (const row of rows) {
      const key = row.target!.toLocaleLowerCase()
      if (!result.has(key)) result.set(key, toInfo(row))
    }
    return result
  }

  private get(id: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined
  }

  info(id: string): JobInfo {
    const row = this.get(id)
    if (!row) throw new JotError('NOT_FOUND', '没有这个任务')
    return toInfo(row)
  }

  private set(id: string, fields: Partial<Pick<JobRow, 'state' | 'attempts' | 'model_waits' | 'next_run_at' | 'error'>>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[]
    this.db.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), this.now(), id)
    if (fields.state === 'done' || fields.state === 'cancelled') this.pruneFinished()
    this.changed(id)
  }

  /** 长时间运行也限量；已取消但仍在退出的处理程序暂时保留，结束后再收口。 */
  private pruneFinished(): number {
    if (!this.state.isOpen) return 0
    return this.db.prepare(`DELETE FROM jobs WHERE state IN ('done','cancelled') AND id <> ?
      AND id NOT IN (SELECT id FROM jobs WHERE state IN ('done','cancelled') ORDER BY updated_at DESC,id DESC LIMIT 200)`)
      .run(this.running?.id ?? '').changes
  }
  get isRunning(): boolean { return this.running !== null }

  summary(): JobSummary {
    const rows = this.db.prepare('SELECT state, COUNT(*) n FROM jobs GROUP BY state').all() as { state: JobState; n: number }[]
    const n = (s: JobState) => rows.find((r) => r.state === s)?.n ?? 0
    return { running: n('running'), queued: n('queued') + n('waiting-model'), failed: n('failed'), waitingModel: n('waiting-model') }
  }

  private changed(id?: string): void {
    const job = id ? this.get(id) : undefined
    const summary = this.summary()
    for (const l of this.listeners) l(summary, job ? toInfo(job) : undefined)
  }

  list(filter: { state?: JobState; states?: JobState[] } = {}, page: { limit?: number; offset?: number } = {}): Paged<JobInfo> {
    const states = filter.states?.length ? filter.states : filter.state ? [filter.state] : undefined
    const where = states ? 'WHERE state IN (' + states.map(() => '?').join(',') + ')' : "WHERE state NOT IN ('done', 'cancelled')"
    const args = states ?? []
    const total = (this.db.prepare(`SELECT COUNT(*) n FROM jobs ${where}`).get(...args) as { n: number }).n
    const rows = this.db.prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args, page.limit ?? 50, page.offset ?? 0) as JobRow[]
    return { items: rows.map(toInfo), total }
  }

  retry(id: string): void {
    const job = this.get(id)
    if (!job) throw new JotError('NOT_FOUND', '没有这个任务')
    if (job.state === 'running' || job.state === 'done') return
    this.set(id, { state: 'queued', attempts: 0, model_waits: 0, next_run_at: this.now(), error: null })
    this.schedule()
  }

  cancel(id: string): void {
    const job = this.get(id)
    if (!job) throw new JotError('NOT_FOUND', '没有这个任务')
    if (job.state === 'done' || job.state === 'cancelled') return
    if (this.running?.id === id) this.running.abort.abort()
    this.set(id, { state: 'cancelled', error: null })
  }

  /** 模型恢复或设置变了：等待模型的任务立刻重试 */
  kick(): void {
    if (!this.state.isOpen) return
    this.db.prepare("UPDATE jobs SET next_run_at = ? WHERE state = 'waiting-model'").run(this.now())
    this.schedule()
  }

  private due(): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE state IN ('queued', 'waiting-model') AND next_run_at <= ? ORDER BY next_run_at, created_at LIMIT 1").get(this.now()) as JobRow | undefined
  }

  /** 安排下一次执行：有到期的任务就马上跑，否则等到最近的一个到期 */
  private schedule(): void {
    if (!this.started || !this.state.isOpen) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.due()) {
      this.loop = this.loop.then(() => this.drain()).catch((e) => console.error('[jobs] 执行出错：', e))
      return
    }
    const next = this.db.prepare("SELECT MIN(next_run_at) t FROM jobs WHERE state IN ('queued', 'waiting-model')").get() as { t: number | null }
    if (next.t !== null) this.timer = setTimeout(() => this.schedule(), Math.min(Math.max(next.t - this.now(), 50), 600_000))
  }

  /** 等正在跑和已经安排好的任务都结束（到期时间还没到的不等） */
  async settle(): Promise<void> {
    let seen: Promise<void>
    do {
      seen = this.loop
      await seen.catch(() => {})
    } while (seen !== this.loop)
  }

  /** 把已经到期的任务依次跑完。测试里直接调用它。 */
  async drain(): Promise<void> {
    for (let job = this.due(); job && this.state.isOpen; job = this.due()) await this.runOne(job)
    if (this.started) this.schedule()
  }

  private async runOne(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.type)
    if (!handler) {
      this.set(job.id, { state: 'failed', error: `没有处理 ${job.type} 的程序` })
      return
    }
    const abort = new AbortController()
    this.running = { id: job.id, abort }
    const { execution: _execution, resultNote: _note, ...payload } = JSON.parse(job.payload)
    this.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify(payload), job.id)
    this.set(job.id, { state: 'running' })
    try {
      const note = await handler(JSON.parse(job.payload) as Record<string, unknown>, { jobId: job.id, signal: abort.signal, recordExecution: execution => {
        if (abort.signal.aborted || !this.state.isOpen || this.running?.id !== job.id) return
        const current = this.get(job.id)
        if (current?.state !== 'running') return
        this.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(current.payload), execution }), job.id)
        this.changed(job.id)
      } })
      const current = this.get(job.id)
      if (current?.state === 'running') {
        if (typeof note === 'string') this.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(current.payload), resultNote: note.slice(0, 1000) }), job.id)
        this.set(job.id, { state: 'done', error: null })
      }
    } catch (e) {
      if (!this.state.isOpen || this.get(job.id)?.state !== 'running') return
      const code = e instanceof JotError ? e.code : 'INTERNAL'
      const message = e instanceof Error ? e.message : String(e)
      if (code === 'CANCELLED') {
        this.set(job.id, { state: 'cancelled', error: null })
      } else if (code === 'LLM_NOT_CONFIGURED' || code === 'LLM_UNAVAILABLE') {
        // 模型不可用：不算失败，隔一阵再试；没配置时等设置变化来唤醒
        const wait = MODEL_WAIT_MS[Math.min(job.model_waits, MODEL_WAIT_MS.length - 1)]!
        this.set(job.id, { state: 'waiting-model', model_waits: job.model_waits + 1, next_run_at: this.now() + (code === 'LLM_NOT_CONFIGURED' ? 3_600_000 : wait), error: message })
      } else if (code === 'LLM_REASONING_UNSUPPORTED' || job.type !== 'reindex' && (code === 'INVALID_INPUT' || code === 'LLM_CONTEXT_LIMIT')) {
        this.set(job.id, { state: 'failed', attempts: job.attempts + 1, error: message })
      } else if (job.type === 'classify' && code === 'LLM_BAD_OUTPUT') {
        // 正文不可分析或整理结果无效时等用户处理，不反复提交同一份材料。
        this.set(job.id, { state: 'failed', attempts: job.attempts + 1, error: message })
      } else if (code === 'NOT_FOUND') {
        // 目标已经不在了（比如文件被删），不用再试
        this.set(job.id, { state: 'cancelled', error: message })
      } else {
        const attempts = job.attempts + 1
        const delay = RETRY_MS[attempts - 1]
        if (delay === undefined) this.set(job.id, { state: 'failed', attempts, error: message })
        else this.set(job.id, { state: 'queued', attempts, next_run_at: this.now() + delay, error: message })
      }
    } finally {
      this.running = null
      if (this.pruneFinished()) this.changed()
    }
  }
}

export const pathJobKey = (type: JobType, rel: string): string => type + ':path:' + normalizeRel(rel).toLocaleLowerCase()
export type JobSummary = JobsSummary
