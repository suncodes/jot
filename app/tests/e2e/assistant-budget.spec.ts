import { defaultModel } from '../helpers/models'
import { modelSettings } from '../helpers/models'
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, callOnPage } from './file-fixture'
import { launch, shot, selectOption } from './helpers'
import { agentScript, isAgentRequest, startFakeLlm } from '../helpers/fake-llm'

test('窗口档位与压缩比例配置、精确输入校验、跨重启与恢复256K；最大输出由程序处理', async ({ jot }) => {
  const { page, call, launched } = jot
  const fake = await startFakeLlm(agentScript([() => '预算配置已生效']))
  let resumed: Awaited<ReturnType<typeof launch>> | undefined
  try {
    await page.getByTestId('ribbon-settings').click()
    await page.getByTestId('settings-nav-model').click()
    await expect(page.getByTestId('model-context-window')).toBeHidden()
    await page.getByTestId('model-base-url').fill(fake.baseUrl)
    await page.getByTestId('model-name').fill('fake-budget')
    await page.getByTestId('model-api-key').fill('fake')
    await page.getByTestId('settings-nav-model').click()
    if (await page.getByTestId('model-advanced').getAttribute('open') === null) await page.getByTestId('model-advanced').locator('summary').click()
    await expect(page.getByTestId('model-context-window')).toHaveAttribute('data-value', '262144')
    await expect(page.getByTestId('model-compaction-threshold')).toHaveAttribute('data-value', '0.7')
    await expect(page.getByTestId('model-max-output')).toHaveCount(0)
    await expect(page.getByTestId('model-budget-preview')).toContainText('262,144 Token · 手动设置')
    await page.getByTestId('model-context-window').click()
    for (const label of ['8K', '16K', '32K', '64K', '128K', '200K', '256K', '512K', '1M', '2M']) {
      await expect(page.getByTestId('select-options').getByRole('option', { name: new RegExp('^' + label + '$') })).toHaveCount(1)
    }
    await shot(page, 'model-window-options-light')
    await page.getByTestId('select-options').locator('[data-value="other"]').click()
    await page.getByTestId('model-context-custom').fill('100')
    await page.getByTestId('model-save').click()
    await expect(page.getByTestId('model-save-error')).toContainText('4,096')
    expect(defaultModel((await call('settings:get', undefined)))).not.toHaveProperty('contextWindow')
    await page.getByTestId('model-context-custom').fill('128000')
    await expect(page.getByTestId('model-budget-preview')).toContainText('128,000 Token · 手动设置')
    await selectOption(page, 'model-context-window', '16384')
    await expect(page.getByTestId('model-context-custom')).toHaveCount(0)
    await selectOption(page, 'model-compaction-threshold', '0.8')
    await page.getByTestId('model-save').click()
    await expect(page.getByTestId('model-save-error')).toHaveCount(0)
    expect(defaultModel((await call('settings:get', undefined)))).toMatchObject({ contextWindow: 16384, compactionThreshold: 0.8 })
    expect(defaultModel((await call('settings:get', undefined)))).not.toHaveProperty('maxOutputTokens')
    await expect(page.getByTestId('model-budget-preview')).toContainText('16,384 Token · 手动设置')
    expect(fake.requests).toHaveLength(0)
    await shot(page, 'model-window-config-light')
    await page.getByTestId('ribbon-settings').click()
    await page.keyboard.press('Control+l')
    await page.getByTestId('agent-input').fill('说明上下文预算')
    await page.getByTestId('agent-send').click()
    await expect(page.getByTestId('agent-stop')).toHaveCount(0)
    await expect(page.getByTestId('agent-context-budget')).toHaveAttribute('title', /窗口 16,384 Token.*预留输出 5,461/)
    const conversation = (await call('agent:conversations', {})).items[0]!.conversationId
    const saved = (await call('agent:get', { conversationId: conversation })).messages.at(-1)!.budget!
    expect(saved).toMatchObject({ contextWindow: 16384, maxOutputTokens: 5461, compactionThreshold: 0.8, source: 'custom', blocked: false })
    const request = fake.requests.filter(isAgentRequest).at(-1)!
    expect(request.max_tokens ?? request.max_completion_tokens).toBe(5461)
    await page.getByTestId('ribbon-settings').click()
    await page.getByTestId('theme-toggle').click()
    await page.setViewportSize({ width: 640, height: 800 })
    await page.getByTestId('settings-nav-model').click()
    if (await page.getByTestId('model-advanced').getAttribute('open') === null) await page.getByTestId('model-advanced').locator('summary').click()
    await page.getByTestId('model-compaction-threshold').scrollIntoViewIfNeeded()
    expect((await page.getByTestId('model-context-window').boundingBox())!.width).toBeGreaterThan(90)
    await shot(page, 'model-window-config-dark-narrow')

    await launched.close()
    resumed = await launch({ reuse: launched, isolateHotkey: true })
    const next = resumed.page
    await expect(next.getByTestId('shell')).toBeVisible()
    await next.getByTestId('ribbon-settings').click()
    await next.getByTestId('settings-nav-model').click()
    if (await next.getByTestId('model-advanced').getAttribute('open') === null) await next.getByTestId('model-advanced').locator('summary').click()
    await expect(next.getByTestId('model-context-window')).toHaveAttribute('data-value', '16384')
    await expect(next.getByTestId('model-compaction-threshold')).toHaveAttribute('data-value', '0.8')
    await selectOption(next, 'model-context-window', 'other')
    await next.getByTestId('model-context-custom').fill('128000')
    await next.getByTestId('model-save').click()
    expect(defaultModel((await callOnPage(next, 'settings:get', undefined))).contextWindow).toBe(128000)
    await selectOption(next, 'model-context-window', '262144')
    await next.getByTestId('model-save').click()
    await expect.poll(async () => defaultModel((await callOnPage(next, 'settings:get', undefined))).contextWindow).toBe(262144)
    await expect(next.getByTestId('model-budget-preview')).toContainText('262,144 Token · 手动设置')
    await selectOption(next, 'model-compaction-threshold', '0.6')
    await next.getByTestId('model-save').click()
    await next.getByTestId('ribbon-settings').click()
    if (!(await next.getByTestId('agent').isVisible())) await next.keyboard.press('Control+l')
    await next.getByTestId('agent-history').click()
    await next.getByTestId('agent-conversation').first().locator('.history-main').click()
    await next.getByTestId('agent-input').fill('使用配置的窗口继续')
    await next.getByTestId('agent-send').click()
    await expect(next.getByTestId('agent-stop')).toHaveCount(0)
    await expect(next.getByTestId('agent-context-budget')).toHaveAttribute('title', /窗口 262,144 Token.*手动设置/)
    expect((await callOnPage(next, 'agent:get', { conversationId: conversation })).messages.at(-1)?.budget?.compactionThreshold).toBe(0.6)
    await next.getByTestId('ribbon-settings').click()
    await next.getByTestId('settings-nav-model').click()
    if (await next.getByTestId('model-advanced').getAttribute('open') === null) await next.getByTestId('model-advanced').locator('summary').click()
    await selectOption(next, 'model-context-window', '8192')
    await next.getByTestId('model-name').fill('another-model')
    await expect(next.getByTestId('model-context-window')).toHaveAttribute('data-value', '262144')
    await expect(next.getByTestId('model-compaction-threshold')).toHaveAttribute('data-value', '0.6')
    await next.getByTestId('model-save').click()
    expect(defaultModel((await callOnPage(next, 'settings:get', undefined)))).toMatchObject({ model: 'another-model', compactionThreshold: 0.6 })
    expect(defaultModel((await callOnPage(next, 'settings:get', undefined))).contextWindow).toBe(262144)
  } finally { await resumed?.close(); await fake.close() }
})

test('大工具累计材料超限显示可行动原因和占比，过程仍可查，分段读取后继续', async ({ jot }) => {
  const { page, call, write, vault } = jot
  const file = 'content/工作/大材料.md'
  const original = Array.from({ length: 100 }, (_, i) => '第' + i + '行 ' + '材料'.repeat(70)).join('\n')
  write(file, original)
  await call('vault:refreshIndex', {})
  const fake = await startFakeLlm(agentScript([
    () => ({ toolCall: { name: 'read', arguments: { path: file } } }),
    () => ({ toolCall: { name: 'read', arguments: { path: file, lineStart: 50 } } }),
    () => '不应该发送的第三次请求',
  ]))
  try {
    await call('settings:set', { ...modelSettings({ baseUrl: fake.baseUrl, model: 'small', apiKey: 'fake', contextWindow: 28672 }, await call('settings:get', undefined)) })
    await page.keyboard.press('Control+l')
    await page.getByTestId('agent-input').fill('读取大材料')
    await page.getByTestId('agent-send').click()
    await expect(page.getByTestId('agent-stop')).toHaveCount(0)
    await expect(page.getByTestId('agent-message-error')).toContainText('分段读取')
    await expect(page.getByTestId('agent-context-budget')).toHaveClass(/context-near-limit/)
    await expect(page.getByTestId('agent-context-budget')).toHaveAttribute('title', /窗口 28,672 Token/)
    const id = (await call('agent:conversations', {})).items[0]!.conversationId
    const failed = (await call('agent:get', { conversationId: id })).messages.at(-1)!
    expect(failed.toolCalls).toHaveLength(2)
    expect(failed.budget?.blocked).toBe(true)
    expect(fake.requests.filter(isAgentRequest)).toHaveLength(2)
    await shot(page, 'assistant-budget-overflow')
    fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'read', arguments: { path: file, lineStart: 50, lineEnd: 51 } } }),
      () => '分段读取完成',
    ]))
    await page.getByTestId('agent-input').fill('只读取第50到51行')
    await page.getByTestId('agent-send').click()
    await expect(page.getByTestId('agent-stop')).toHaveCount(0)
    await expect(page.getByTestId('agent-answer').last()).toContainText('分段读取完成')
    expect((await call('agent:get', { conversationId: id })).messages.at(-1)!.budget?.blocked).toBe(false)
    expect(fs.readFileSync(path.join(vault, file), 'utf8')).toBe(original)
    expect((await call('agent:get', { conversationId: id })).messages[1]!.toolCalls).toHaveLength(2)
  } finally { await fake.close() }
})
