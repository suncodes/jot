import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DailyOutput } from '../../electron/pipelines/daily'
import { deferred, testApp } from '../helpers/test-app'
import { agentScript, isAgentRequest } from '../helpers/fake-llm'
import { reasoningModelKey } from '../../shared/reasoning'

let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { vi.restoreAllMocks(); await app.close() })
const date = '2026-11-19', journal = 'journal/2026/' + date + '.md'
const contract = '{"oneLine":"一句话","done":[],"highlights":[],"followUps":[]}'
const answer = JSON.stringify({ oneLine: '完成明确记录中的事项', done: ['完成测试记录'] })

describe('U4 共用执行器与日总结', () => {
  it('在途改档只影响下一轮，当前工具续跑继续使用启动档位', async () => {
    await app.call('settings:set', { model: { reasoningEffort: 'high' } })
    const started = deferred(), hold = deferred(), before = app.fake.requests.length
    app.fake.setResponder(async (_req, index) => {
      if (index === before) { started.release(); await hold.promise; return { toolCall: { name: 'stats', arguments: {} } } }
      return '已完成核对'
    })
    const id = app.core.agent.create().conversationId
    const { runId } = app.core.agent.send(id, '核对统计')
    await started.promise
    await app.call('settings:set', { model: { reasoningEffort: 'low' } })
    expect(app.core.agent.get(id).running).toBe(runId)
    hold.release(); await app.core.agent.wait(runId)
    expect(app.core.agent.get(id).messages.at(-1)?.error).toBeUndefined()
    expect(app.fake.requests.slice(before).map(req => req.reasoning_effort)).toEqual(['high', 'high'])
    const next = app.core.agent.send(id, '接着核对'); await app.core.agent.wait(next.runId)
    expect(app.fake.requests.at(-1)?.reasoning_effort).toBe('low')
  })

  it('默认技能真实加载，后台继承全局且不带聊天历史或文件管理工具', async () => {
    await app.call('settings:set', { model: { reasoningEffort: 'high' } })
    app.fake.setResponder(agentScript([() => '私人回答'], () => answer))
    const conversation = app.core.agent.create()
    const run = app.core.agent.send(conversation.conversationId, '不应进入后台的私人问题', { agentId: 'default', references: [], skillIds: [], strict: false, reasoningEffort: 'low' })
    await app.core.agent.wait(run.runId)
    await app.call('capture:save', { text: '明确记录今天完成测试', source: 'main-window' })
    await app.core.idle()
    const { jobId } = await app.core.daily.request(date)
    await app.core.jobs.drain(); await app.core.idle()
    const info = app.core.jobs.info(jobId)
    expect(info).toMatchObject({ state: 'done', note: '日总结已保存', execution: { model: 'fake', skillId: 'jot-core:daily-review', reasoning: { requested: 'high', source: 'global', parameters: { reasoning_effort: 'high' } } } })
    expect(info.execution?.reasoning).not.toHaveProperty('reported')
    const task = app.fake.requests.find(req => !isAgentRequest(req))!
    expect(task.reasoning_effort).toBe('high')
    expect(JSON.stringify(task.messages[0])).toContain('每日回顾')
    expect(JSON.stringify(task.messages)).not.toContain('私人回答')
    expect(JSON.stringify(task.messages)).toContain('用户讨论（不代表完成）')
    expect((task.tools as { function: { name: string } }[]).map(tool => tool.function.name)).toEqual(['use_skill'])
    const saved = await app.core.vault.read({ path: journal })
    expect(saved.properties).toMatchObject({ skill: 'jot-core:daily-review', model: 'fake', reasoning: { requested: 'high', source: 'global' } })
    await app.reopen()
    expect(app.core.jobs.info(jobId).execution?.reasoning?.requested).toBe('high')
  })

  it('格式错误最多纠正一次，纠正沿用同一模型与推理档位', async () => {
    await app.call('settings:set', { model: { reasoningEffort: 'high' } })
    const before = app.fake.requests.length
    app.fake.setResponder((_req, index) => index === before ? '{"oneLine":null}' : answer)
    const task = await app.core.executor.prepare('daily')
    expect((await task.run('虚构材料', DailyOutput, contract)).oneLine).toBe('完成明确记录中的事项')
    expect(app.fake.requests.slice(before).map(req => req.reasoning_effort)).toEqual(['high', 'high'])
    expect(JSON.stringify(app.fake.requests.at(-1)?.messages)).toContain('上一份输出未通过结构校验')
    app.fake.setResponder(() => '不是JSON')
    const again = app.fake.requests.length
    await expect(task.run('虚构材料', DailyOutput, contract)).rejects.toMatchObject({ code: 'LLM_BAD_OUTPUT' })
    expect(app.fake.requests.length - again).toBe(2)
  })

  it('缺失或停用技能明确失败，不请求旧引擎；修复后可重试', async () => {
    await app.call('capture:save', { text: '今天记录了学习想法', source: 'main-window' }); await app.core.idle()
    await app.call('capabilities:changeSkill', { action: 'enable', id: 'jot-core:daily-review', enabled: false })
    const before = app.fake.requests.length, { jobId } = await app.core.daily.request(date)
    await app.core.jobs.drain()
    expect(app.core.jobs.info(jobId)).toMatchObject({ state: 'failed', error: expect.stringContaining('停用') })
    expect(app.fake.requests.length).toBe(before)
    expect(fs.existsSync(app.file(journal))).toBe(false)
    await app.call('capabilities:changeSkill', { action: 'enable', id: 'jot-core:daily-review', enabled: true })
    app.core.jobs.retry(jobId); await app.core.jobs.drain()
    expect(app.core.jobs.info(jobId).state).toBe('done')
  })

  it('可绑定库内材料技能并读取资源，执行期间编辑资源不改变启动副本', async () => {
    await app.call('capabilities:changeSkill', { action: 'save', enabled: true, content: { name: 'my-daily', title: '我的回顾', description: '只整理提供的材料', body: '使用references/rules.md的格式', requiredTools: [] } })
    await app.call('capabilities:patchResources', { owner: 'skill', id: 'my-daily', files: [{ path: 'references/rules.md', content: '启动规则' }] })
    await app.call('capabilities:setTaskSkills', { daily: 'my-daily' })
    const started = deferred(), hold = deferred(), before = app.fake.requests.length
    app.fake.setResponder(async (_req, index) => {
      if (index === before) { started.release(); await hold.promise; return { toolCall: { name: 'use_skill', arguments: { name: 'my-daily', path: 'references/rules.md' } } } }
      return answer
    })
    const task = await app.core.executor.prepare('daily')
    const pending = task.run('明确材料', DailyOutput, contract)
    await started.promise
    await app.call('capabilities:patchResources', { owner: 'skill', id: 'my-daily', files: [{ path: 'references/rules.md', content: '后来的规则' }] })
    hold.release()
    await pending
    expect(task.execution.skillId).toBe('my-daily')
    const text = JSON.stringify(app.fake.requests.at(-1)!.messages)
    expect(text).toContain('启动规则'); expect(text).not.toContain('后来的规则')
    const invalid = await app.call('capabilities:setTaskSkills', { daily: 'work-review:weekly-report' })
    expect(invalid.taskBindings.find(binding => binding.task === 'daily')?.issues).toContainEqual(expect.stringContaining('后台任务不开放工具'))
  })

  it('显式强度拒绝立即失败并记录原档位，不自动去参或队列重试', async () => {
    await app.call('settings:set', { model: { reasoningEffort: 'high' } })
    await app.call('capture:save', { text: '今天完成测试', source: 'main-window' }); await app.core.idle()
    app.fake.setResponder(() => ({ status: 400, body: '{"error":{"message":"unsupported reasoning_effort high"}}' }))
    const before = app.fake.requests.length, { jobId } = await app.core.daily.request(date)
    await app.core.jobs.drain()
    expect(app.core.jobs.info(jobId)).toMatchObject({ state: 'failed', error: expect.stringContaining('未自动降档'), execution: { reasoning: { requested: 'high' } } })
    expect(app.fake.requests.length - before).toBe(1)
    expect(fs.existsSync(app.file(journal))).toBe(false)
  })

  it('取消任务或切库后不落迟到结果；模型等待期间不持库操作队列', async () => {
    await app.call('capture:save', { text: '今天完成测试', source: 'main-window' }); await app.core.idle()
    const started = deferred(), hold = deferred()
    app.fake.setResponder(async () => { started.release(); await hold.promise; return answer })
    const { jobId } = await app.core.daily.request(date), pending = app.core.jobs.drain()
    await started.promise
    await app.core.mutate(() => app.core.vault.createFolder('content', '等待时可操作'))
    app.core.jobs.cancel(jobId)
    await pending
    expect(app.core.jobs.info(jobId).state).toBe('cancelled')
    expect(fs.existsSync(app.file(journal))).toBe(false)
    hold.release()
    const started2 = deferred(), hold2 = deferred()
    app.fake.setResponder(async () => { started2.release(); await hold2.promise; return answer })
    const run = app.core.daily.run(date)
    const check = expect(run).rejects.toMatchObject({ code: 'CANCELLED' })
    await started2.promise
    const other = path.join(app.tmp.dir, 'other-vault')
    await app.core.openVault(other, true); await app.core.jobs.stop()
    hold2.release(); await check
    expect(fs.existsSync(path.join(other, journal))).toBe(false)
    expect(fs.existsSync(app.file(journal))).toBe(false)
  })

  it('没有模型也可保留纯更新列表，不伪造技能和模型执行记录', async () => {
    const config = vi.spyOn(app.core.pi, 'configuration').mockImplementation(() => { throw new Error('无模型配置') })
    app.write('content/工作/规则.md', '---\ncreated: 2026-11-19\n---\n规则全文')
    await app.core.syncIndex()
    await app.call('capabilities:setPluginEnabled', { id: 'jot-core', enabled: false })
    const { jobId } = await app.core.daily.request(date)
    await app.core.jobs.drain()
    expect(app.core.jobs.info(jobId)).toMatchObject({ state: 'done' })
    expect(app.core.jobs.info(jobId).execution).toBeUndefined()
    const saved = await app.core.vault.read({ path: journal })
    expect(saved.properties).not.toHaveProperty('skill')
    expect(saved.properties).not.toHaveProperty('model')
    expect(config).not.toHaveBeenCalled()
    expect(app.fake.requests).toHaveLength(0)
  })

  it('对话覆盖跨重启承接，显式auto覆盖全局，更换模型清除后续覆盖', async () => {
    await app.call('settings:set', { model: { reasoningEffort: 'high' } })
    app.fake.setResponder(() => '完成')
    const id = app.core.agent.create().conversationId
    const run = app.core.agent.send(id, '第一个问题', { agentId: 'default', references: [], strict: false, skillIds: [], reasoningEffort: 'auto' })
    await app.core.agent.wait(run.runId)
    expect(app.fake.requests.at(-1)?.reasoning_effort).toBeUndefined()
    expect(app.core.agent.get(id).messages.at(-1)?.context?.reasoning).toMatchObject({ requested: 'auto', source: 'conversation' })
    await app.call('agent:setReasoning', { conversationId: id, effort: 'low' })
    expect(app.core.agent.get(id).context?.reasoningEffort).toBe('low')
    await app.call('agent:setReasoning', { conversationId: id, effort: 'auto' })
    const identity = reasoningModelKey(app.core.settings.get().model)
    await app.reopen()
    expect(app.core.agent.get(id).context).toMatchObject({ reasoningEffort: 'auto', reasoningModel: identity })
    const next = app.core.agent.send(id, '接着做'); await app.core.agent.wait(next.runId)
    expect(app.fake.requests.at(-1)?.reasoning_effort).toBeUndefined()
    await app.call('settings:set', { model: { baseUrl: app.fake.baseUrl, model: 'new-model' } })
    expect(app.core.agent.get(id).context?.reasoningEffort).toBeUndefined()
    await app.call('settings:set', { model: { model: 'fake' } })
    expect(app.core.agent.get(id).context?.reasoningEffort).toBeUndefined()
    expect(app.core.agent.get(id).messages[1]?.context?.reasoning?.requested).toBe('auto')
    await expect(app.core.executor.prepare('daily', AbortSignal.abort())).rejects.toMatchObject({ code: 'CANCELLED' })
  })
})