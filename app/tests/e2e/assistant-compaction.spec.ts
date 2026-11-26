import { test, expect, callOnPage } from './file-fixture'
import { launch, shot } from './helpers'
import { agentScript, isAgentRequest, isCompactionRequest, startFakeLlm } from '../helpers/fake-llm'
import type { Page } from '@playwright/test'

const summary = '用户持续比较实现方案，要求保留原始文件和完整历史。下一步继续核对待办，写入前明确实际存储目录。'
async function ask(page: Page, text: string, answers: number): Promise<void> {
  await page.getByTestId('agent-input').fill(text)
  await page.getByTestId('agent-send').click()
  await expect(page.getByTestId('agent-answer')).toHaveCount(answers)
  await expect(page.getByTestId('agent-stop')).toHaveCount(0)
}
async function fill(page: Page): Promise<void> {
  for (let i = 0; i < 6; i++) await ask(page, '第' + i + '轮，' + '方案细节'.repeat(240), i + 1)
}

test('后台整理保留完整历史，重启后沿用摘要和最近原文，普通下一问无等待提示', async ({ jot }) => {
  const { page, call, launched } = jot
  const fake = await startFakeLlm(agentScript([() => '回答中保留明确需求'], req => isCompactionRequest(req) ? summary : '好'))
  let resumed: Awaited<ReturnType<typeof launch>> | undefined
  try {
    await call('settings:set', { model: { baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake', contextWindow: 16384 } })
    await page.keyboard.press('Control+l')
    await fill(page)
    await expect.poll(() => fake.requests.filter(isCompactionRequest).length).toBe(1)
    const id = (await call('agent:conversations', {})).items[0]!.conversationId
    expect((await call('agent:get', { conversationId: id })).messages).toHaveLength(12)
    await ask(page, '整理完成后继续', 7)
    await expect(page.getByTestId('agent-context-budget')).toHaveAttribute('title', /摘要承接较早 4 轮/)
    await expect(page.getByTestId('agent-compacting')).toHaveCount(0)
    const before = (await call('agent:get', { conversationId: id })).messages
    expect(before).toHaveLength(14)
    const request = fake.requests.filter(isAgentRequest).at(-1)!
    expect(JSON.stringify(request.messages)).toContain(summary)
    expect(JSON.stringify(request.messages)).toContain('第5轮，')
    expect(JSON.stringify(request.messages)).not.toContain('第0轮，')
    await shot(page, 'assistant-compaction-summary-light')

    await launched.close()
    resumed = await launch({ reuse: launched })
    const next = resumed.page
    await expect(next.getByTestId('shell')).toBeVisible()
    if (!(await next.getByTestId('agent').isVisible())) await next.keyboard.press('Control+l')
    await next.getByTestId('agent-history').click()
    await next.getByTestId('agent-conversation').first().locator('.history-main').click()
    await expect(next.getByTestId('agent-answer')).toHaveCount(7)
    await expect(next.getByTestId('agent-context-budget')).toHaveAttribute('title', /摘要承接较早 4 轮/)
    await ask(next, '重启后接着讨论', 8)
    const recovered = (await callOnPage(next, 'agent:get', { conversationId: id })).messages
    expect(recovered.slice(0, 14)).toEqual(before)
    expect(recovered.at(-1)?.budget?.summarizedTurns).toBeGreaterThanOrEqual(4)
    expect(JSON.stringify(fake.requests.filter(isAgentRequest).at(-1)!.messages)).toContain(summary)
  } finally { await resumed?.close(); await fake.close() }
})

test('只有空间不足显示整理状态，切回会话可恢复等待，停止立即结束；摘要失败后保留历史继续', async ({ jot }) => {
  const { page, call } = jot
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const fake = await startFakeLlm(agentScript([() => '短回答'], async req => {
    if (isCompactionRequest(req)) { await pending; return { status: 400, body: '{"error":{"message":"虚构摘要失败"}}' } }
    return '好'
  }))
  try {
    await call('settings:set', { model: { baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake', contextWindow: 26624 } })
    await page.keyboard.press('Control+l')
    await fill(page)
    await expect.poll(() => fake.requests.filter(isCompactionRequest).length).toBe(1)
    const id = (await call('agent:conversations', {})).items[0]!.conversationId
    await ask(page, '第七轮短追问', 7)
    expect((await call('agent:get', { conversationId: id })).messages.at(-1)?.budget?.omittedHistoryTurns).toBe(0)
    await expect(page.getByTestId('agent-compacting')).toHaveCount(0)
    await page.getByTestId('agent-input').fill('第八轮需要空间' + '详细约束'.repeat(650))
    await page.getByTestId('agent-send').click()
    const waiting = page.getByTestId('agent-compacting')
    await expect(waiting).toHaveText('正在整理较早的对话…')
    await shot(page, 'assistant-compaction-waiting-light')
    await page.getByTestId('theme-toggle').click()
    await page.setViewportSize({ width: 640, height: 800 })
    await waiting.scrollIntoViewIfNeeded()
    await expect(waiting).toBeVisible()
    await shot(page, 'assistant-compaction-waiting-dark-narrow')
    await page.getByTestId('agent-history').click()
    await page.getByTestId('agent-conversation').first().locator('.history-main').click()
    await expect(waiting).toBeVisible()
    await page.getByTestId('agent-stop').click()
    await expect(page.getByTestId('agent-stop')).toHaveCount(0)
    await expect(waiting).toHaveCount(0)
    await expect(page.getByTestId('agent-message-error').last()).toHaveText('已停止')
    const stopped = (await call('agent:get', { conversationId: id })).messages
    expect(stopped).toHaveLength(16)
    expect(stopped.at(-2)?.text).toContain('第八轮需要空间')
    release()
    await ask(page, '摘要失败后继续，按当前材料回答', 9)
    expect((await call('agent:get', { conversationId: id })).messages.at(-1)?.error).toBeUndefined()
    await expect(page.getByTestId('agent-compacting')).toHaveCount(0)
    expect((await call('agent:get', { conversationId: id })).messages).toHaveLength(18)
  } finally { release(); await fake.close() }
})

test('等待中的摘要完成后自动继续本轮回答，等待结束事件不会提前结束回答', async ({ jot }) => {
  const { page, call } = jot
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const fake = await startFakeLlm(agentScript([() => '新的回答已接上较早的目标和约束'], async req => {
    if (isCompactionRequest(req)) { await pending; return summary }
    return '好'
  }))
  try {
    await call('settings:set', { model: { baseUrl: fake.baseUrl, model: 'fake', apiKey: 'fake', contextWindow: 16384 } })
    await page.keyboard.press('Control+l')
    await fill(page)
    await expect.poll(() => fake.requests.filter(isCompactionRequest).length).toBe(1)
    await page.getByTestId('agent-input').fill('等待整理后接着讨论')
    await page.getByTestId('agent-send').click()
    await expect(page.getByTestId('agent-compacting')).toBeVisible()
    release()
    await expect(page.getByTestId('agent-stop')).toHaveCount(0)
    await expect(page.getByTestId('agent-compacting')).toHaveCount(0)
    await expect(page.getByTestId('agent-answer').last()).toContainText('新的回答已接上较早的目标和约束')
    await expect(page.getByTestId('agent-context-budget')).toHaveAttribute('title', /摘要承接较早 4 轮/)
    const id = (await call('agent:conversations', {})).items[0]!.conversationId
    const messages = (await call('agent:get', { conversationId: id })).messages
    expect(messages).toHaveLength(14)
    expect(messages.at(-1)?.error).toBeUndefined()
    expect(JSON.stringify(fake.requests.filter(isAgentRequest).at(-1)!.messages)).toContain(summary)
  } finally { release(); await fake.close() }
})
