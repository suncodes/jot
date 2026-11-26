import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JotError } from '@shared/result'
import { JobQueue } from '../../electron/jobs/queue'
import { StateStore } from '../../electron/state/state'
import { makeTmpDir } from '../helpers/tmp'

let tmp: ReturnType<typeof makeTmpDir>
let state: StateStore
let queue: JobQueue
let clock: number
const file = () => path.join(tmp.dir, 'state.db')
const job = (id: string) => queue.list({}).items.find((j) => j.jobId === id) ?? queue.list({ state: 'done' }).items.find((j) => j.jobId === id) ?? queue.list({ state: 'cancelled' }).items.find((j) => j.jobId === id)

beforeEach(() => {
  tmp = makeTmpDir('queue')
  state = new StateStore()
  state.open(file())
  clock = 1_000_000
  queue = new JobQueue(state, () => clock)
})
afterEach(() => {
  state.close()
  tmp.cleanup()
})

describe('任务队列', () => {
  it('按多个状态合并分页，进行中不混入等待或已完成的任务', async () => {
    queue.register('classify', async () => {})
    queue.enqueue('classify', {})
    await queue.drain()
    clock++
    const waiting = queue.enqueue('classify', {})
    state.raw.prepare("UPDATE jobs SET state = 'waiting-model' WHERE id = ?").run(waiting)
    clock++
    const first = queue.enqueue('classify', {})
    clock++
    const second = queue.enqueue('classify', {})
    state.raw.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(second)
    const filter = { states: ['queued', 'running'] as const }
    expect(queue.list({ states: [...filter.states] }, { limit: 1 })).toMatchObject({ total: 2, items: [{ jobId: second, state: 'running' }] })
    expect(queue.list({ states: [...filter.states] }, { limit: 1, offset: 1 })).toMatchObject({ total: 2, items: [{ jobId: first, state: 'queued' }] })
    expect(queue.list({ state: 'done' }).total).toBe(1)
    expect(queue.list().total).toBe(3)
  })

  it('按顺序执行，完成后标记为完成', async () => {
    const ran: unknown[] = []
    queue.register('classify', async (p) => void ran.push(p.n))
    const a = queue.enqueue('classify', { n: 1 })
    queue.enqueue('classify', { n: 2 })
    await queue.drain()
    expect(ran).toEqual([1, 2])
    expect(job(a)?.state).toBe('done')
    expect(queue.summary()).toEqual({ running: 0, queued: 0, failed: 0, waitingModel: 0 })
  })

  it('相同的去重键在结束前不重复排队，结束后可以再排', async () => {
    queue.register('classify', async () => {})
    const a = queue.enqueue('classify', {}, { dedupeKey: 'k' })
    expect(queue.enqueue('classify', {}, { dedupeKey: 'k' })).toBe(a)
    await queue.drain()
    expect(queue.enqueue('classify', {}, { dedupeKey: 'k' })).not.toBe(a)
  })

  it('普通错误按 15 秒、1 分钟、5 分钟重试，之后标记为失败', async () => {
    let calls = 0
    queue.register('classify', async () => {
      calls++
      throw new Error('出错了')
    })
    const id = queue.enqueue('classify', {})
    await queue.drain()
    expect(job(id)).toMatchObject({ state: 'queued', attempts: 1, error: '出错了' })
    // 时间没到不会重跑
    clock += 14_000
    await queue.drain()
    expect(calls).toBe(1)
    for (const wait of [1_000, 60_000, 300_000]) {
      clock += wait
      await queue.drain()
    }
    expect(calls).toBe(4)
    expect(job(id)).toMatchObject({ state: 'failed', attempts: 4 })
    expect(queue.summary().failed).toBe(1)

    // 手动重试：次数清零，立刻再跑
    queue.retry(id)
    await queue.drain()
    expect(calls).toBe(5)
    expect(job(id)).toMatchObject({ state: 'queued', attempts: 1 })
  })

  it('模型不可用不算失败：进入等待，隔一阵再试，唤醒后立刻重试', async () => {
    let available = false
    queue.register('classify', async () => {
      if (!available) throw new JotError('LLM_UNAVAILABLE', '连不上')
    })
    const id = queue.enqueue('classify', {})
    await queue.drain()
    expect(job(id)).toMatchObject({ state: 'waiting-model', attempts: 0 })
    expect(queue.summary()).toMatchObject({ waitingModel: 1, failed: 0 })
    clock += 30_000
    await queue.drain()
    expect(job(id)).toMatchObject({ state: 'waiting-model', attempts: 0 })

    available = true
    queue.kick()
    await queue.drain()
    expect(job(id)?.state).toBe('done')
  })

  it('没配置模型时一直等，直到被唤醒', async () => {
    let configured = false
    queue.register('classify', async () => {
      if (!configured) throw new JotError('LLM_NOT_CONFIGURED', '还没有配置模型')
    })
    const id = queue.enqueue('classify', {})
    await queue.drain()
    clock += 600_000
    await queue.drain()
    expect(job(id)?.state).toBe('waiting-model')
    configured = true
    queue.kick()
    await queue.drain()
    expect(job(id)?.state).toBe('done')
  })

  it('目标已经不在时直接取消，不重试', async () => {
    queue.register('classify', async () => {
      throw new JotError('NOT_FOUND', '文件不存在')
    })
    const id = queue.enqueue('classify', {})
    await queue.drain()
    expect(job(id)?.state).toBe('cancelled')
  })

  it('可以取消排队中的任务', async () => {
    let ran = false
    queue.register('classify', async () => void (ran = true))
    const id = queue.enqueue('classify', {})
    queue.cancel(id)
    await queue.drain()
    expect(ran).toBe(false)
    expect(() => queue.retry('nope')).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('任务保存在磁盘上：重启后继续，上次跑到一半的重新排队', async () => {
    queue.enqueue('classify', { n: 1 }, { target: 'inbox/a.md' })
    state.raw.prepare("UPDATE jobs SET state = 'running'").run()
    state.close()

    state.open(file())
    const ran: unknown[] = []
    const next = new JobQueue(state, () => clock)
    next.register('classify', async (p) => void ran.push(p.n))
    next.start()
    await next.settle()
    expect(ran).toEqual([1])
    await next.stop()
  })

  it('状态变化时通知订阅者', async () => {
    const states: string[] = []
    queue.onUpdate((_s, j) => j && states.push(j.state))
    queue.register('classify', async () => {})
    queue.enqueue('classify', {})
    await queue.drain()
    expect(states).toEqual(['queued', 'running', 'done'])
  })

  it('没有注册处理程序的任务标记为失败', async () => {
    const id = queue.enqueue('daily', {})
    await queue.drain()
    expect(job(id)?.state).toBe('failed')
  })
})

it('长期运行完成和取消任务只留最近 200 条，排队、等待模型和失败仍可操作', async () => {
  queue.register('reindex', async () => {})
  const waiting = queue.enqueue('reindex', {}, { runAt: clock + 5000 })
  const failure = queue.enqueue('reindex', {}, { runAt: clock + 5000 })
  const queued = queue.enqueue('reindex', {}, { runAt: clock + 5000 })
  state.raw.prepare("UPDATE jobs SET state='waiting-model' WHERE id=?").run(waiting)
  state.raw.prepare("UPDATE jobs SET state='failed' WHERE id=?").run(failure)
  const completed: string[] = []
  for (let i = 0; i < 225; i++) {
    clock++
    completed.push(queue.enqueue('reindex', {}))
    await queue.drain()
  }
  expect(queue.list({ state: 'done' }).total).toBe(200)
  expect(state.raw.prepare('SELECT id FROM jobs WHERE id=?').get(completed[0])).toBeUndefined()
  for (let i = 0; i < 25; i++) {
    clock++
    queue.cancel(queue.enqueue('reindex', {}))
  }
  expect(queue.list({ states: ['done', 'cancelled'] }).total).toBe(200)
  expect(queue.list({ states: ['queued', 'waiting-model', 'failed'] }).items.map(j => j.jobId).sort()).toEqual([waiting, failure, queued].sort())
  queue.retry(failure)
  expect(state.raw.prepare('SELECT state FROM jobs WHERE id=?').get(failure)).toEqual({ state: 'queued' })
})

it('同毫秒完成任务使用编号稳定保留，取消的在途任务退出后也收口', async () => {
  queue.register('reindex', async () => {})
  for (let i = 0; i < 210; i++) { queue.enqueue('reindex', {}); await queue.drain() }
  expect(queue.list({ state: 'done' }).total).toBe(200)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  queue.register('reindex', async () => { entered(); await gate })
  const id = queue.enqueue('reindex', {})
  const running = queue.drain()
  await started
  queue.cancel(id)
  for (let i = 0; i < 205; i++) queue.cancel(queue.enqueue('reindex', {}))
  expect(state.raw.prepare('SELECT id FROM jobs WHERE id=?').get(id)).toBeDefined()
  release(); await running
  expect(queue.list({ states: ['done', 'cancelled'] }).total).toBe(200)
  expect(queue.isRunning).toBe(false)
})
