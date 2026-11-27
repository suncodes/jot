import fs from 'node:fs'
import path from 'node:path'
import type { ServerResponse } from 'node:http'
import vue from '@vitejs/plugin-vue'
import { createServer } from 'vite'
import { test, expect } from '../chrome/fixtures'
import { testApp } from '../helpers/test-app'
import { startProtocolLlm } from '../helpers/fake-protocols'
import { startModelList } from '../helpers/fake-models'
import type { Channel } from '../../shared/ipc'
import { selectOption } from './helpers'

async function fixture() {
  const clients = new Set<ServerResponse>()
  const app = await testApp((name, payload) => {
    for (const client of clients) client.write('data: ' + JSON.stringify({ name, payload }) + String.fromCharCode(10, 10))
  })
  const responses = await startProtocolLlm('openai-responses'), anthropic = await startProtocolLlm('anthropic-messages')
  const root = path.resolve(import.meta.dirname, '../..')
  const server = await createServer({
    configFile: false, root, cacheDir: path.join(app.tmp.dir, 'vite-cache'),
    plugins: [vue(), {
      name: 'jot-test-ipc',
      configureServer({ middlewares }) {
        middlewares.use('/__jot-test-events', (req, res) => {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.write(': connected' + String.fromCharCode(10, 10)); clients.add(res)
          req.on('close', () => clients.delete(res))
        })
        middlewares.use('/__jot-test-ipc', (req, res) => {
          const chunks: Buffer[] = []
          req.on('data', (chunk: Buffer) => chunks.push(chunk))
          req.on('end', async () => {
            try {
              const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { channel: Channel; args: never }
              const data = await app.call(input.channel, input.args)
              res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, data }))
            } catch (error) { res.end(JSON.stringify({ ok: false, error: { code: 'INVALID_INPUT', message: (error as Error).message } })) }
          })
        })
      },
    }],
    resolve: { alias: { '@': path.join(root, 'src'), '@shared': path.join(root, 'shared') } },
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  return { app, responses, anthropic, url: server.resolvedUrls!.local[0]! + 'tests/chrome/model-form.html',
    async close() { for (const client of clients) client.end(); await server.close(); await responses.close(); await anthropic.close(); await app.close() },
  }
}

test('Chrome：多渠道新增、同渠道多模型、默认设置、连接测试、重载和窄窗', async ({ page }) => {
  const fixtureApp = await fixture(), { app, responses, anthropic } = fixtureApp
  try {
    await page.goto(fixtureApp.url)
    await page.getByTestId('channel-name').fill('Responses 渠道')
    await selectOption(page, 'model-protocol', 'openai-responses')
    await page.getByTestId('model-base-url').fill(responses.baseUrl)
    await page.getByTestId('model-name').fill('fixture-responses')
    await page.getByTestId('model-display-name').fill('日常')
    await page.getByTestId('model-api-key').fill('fixture-key-one')
    await page.getByTestId('model-test').click()
    await expect(page.getByTestId('model-test-result')).toHaveAttribute('data-ok', 'true')
    expect(app.core.settings.getModelConfig()?.protocol).toBe('openai-completions')
    await page.getByTestId('model-advanced').locator('summary').click()
    await selectOption(page, 'model-context-window', '65536')
    await selectOption(page, 'model-reasoning-effort', 'high')
    await page.getByTestId('model-save').click()
    await expect.poll(() => app.core.settings.getModelConfig()?.protocol).toBe('openai-responses')
    const first = app.core.settings.get().models.channels[0]!
    await page.getByTestId('model-add').click()
    await page.getByTestId('model-name').fill('fixture-second')
    await page.getByTestId('model-display-name').fill('写作')
    await page.getByTestId('model-save').click()
    await expect.poll(() => app.core.settings.get().models.channels[0]!.models.length).toBe(2)
    await page.getByTestId('channel-add').click()
    await page.getByTestId('channel-name').fill('Anthropic 渠道')
    await selectOption(page, 'model-protocol', 'anthropic-messages')
    await page.getByTestId('model-base-url').fill(anthropic.baseUrl)
    await page.getByTestId('model-name').fill('fixture-anthropic')
    await page.getByTestId('model-api-key').fill('fixture-key-two')
    await page.getByTestId('model-test').click()
    await expect(page.getByTestId('model-test-result')).toHaveAttribute('data-ok', 'true')
    await page.getByTestId('model-set-default').click()
    await page.getByTestId('model-save').click()
    await expect.poll(() => app.core.settings.getModelConfig()?.protocol).toBe('anthropic-messages')
    await page.reload()
    await page.locator('[data-channel-id="' + first.id + '"]').click()
    await page.locator('[data-model-id="' + first.models[0]!.id + '"]').click()
    await page.getByTestId('model-advanced').locator('summary').click()
    await expect(page.getByTestId('model-context-window')).toHaveAttribute('data-value', '65536')
    await expect(page.getByTestId('model-reasoning-effort')).toHaveAttribute('data-value', 'high')
    await page.getByTestId('model-test').click()
    await expect(page.getByTestId('model-test-result')).toHaveAttribute('data-ok', 'true')
    await page.setViewportSize({ width: 420, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const shot = test.info().outputPath('model-settings.png')
    fs.mkdirSync(path.dirname(shot), { recursive: true })
    await page.screenshot({ path: shot, fullPage: true })
    expect(responses.wireRequests.at(-1)?.headers.authorization).toBe('Bearer fixture-key-one')
    expect(anthropic.wireRequests.at(-1)?.headers['x-api-key']).toBe('fixture-key-two')
    await page.getByTestId('model-delete').click()
    await page.getByTestId('model-remove-confirm').click()
    await page.getByTestId('model-save').click()
    await expect.poll(() => app.core.settings.get().models.channels[0]!.models.length).toBe(1)
    await page.getByTestId('channel-delete').click()
    await page.getByTestId('model-remove-confirm').click()
    await page.getByTestId('model-save').click()
    await expect.poll(() => app.core.settings.get().models.channels.length).toBe(1)
    expect(app.core.settings.getModelConfig()?.protocol).toBe('anthropic-messages')
  } finally { await fixtureApp.close() }
})

test('Chrome：标签右键按左右及其他关闭，保存失败保留标签；助手切换模型保持历史', async ({ page }) => {
  const fixtureApp = await fixture(), { app, responses } = fixtureApp
  const notes = ['content/工作/甲.md', 'content/工作/乙.md', 'content/工作/丙.md']
  for (const note of notes) app.write(note, '# 文件' + note + String.fromCharCode(10) + '初始正文')
  await app.core.syncIndex()
  const models = app.core.settings.get().models
  models.channels.push({ id: 'responses', name: '响应渠道', protocol: 'openai-responses', baseUrl: responses.baseUrl, hasApiKey: false, models: [{ id: 'responses-model', name: '推理模型', model: 'fixture', reasoningEffort: 'auto' }] })
  await app.call('settings:set', { models: { defaultModelId: models.defaultModelId, channels: models.channels.map(({ hasApiKey: _key, ...channel }) => channel) } })
  try {
    await page.goto(fixtureApp.url + '?shell')
    await expect(page.getByTestId('shell')).toBeVisible()
    await page.evaluate(async paths => {
      const tabModule = '/src/stores/tabs.ts'; const { useTabsStore } = await import(/* @vite-ignore */ tabModule)
      const tabs = useTabsStore()
      for (const path of paths) await tabs.open(path, { newTab: true })
    }, notes)
    const tab = (note: string) => page.getByTestId('tab').filter({ has: page.locator('.tab-title', { hasText: note.split('/').pop()!.slice(0, -3) }) })
    await tab(notes[1]!).getByRole('button').first().click({ button: 'right' })
    await page.getByTestId('tab-menu-right').click()
    await expect(page.getByTestId('tab').filter({ hasText: '丙' })).toHaveCount(0)
    await tab(notes[1]!).getByRole('button').first().click({ button: 'right' })
    await page.getByTestId('tab-menu-left').click()
    await expect(page.getByTestId('tab')).toHaveCount(1)
    await page.evaluate(async paths => {
      const tabModule = '/src/stores/tabs.ts'; const { useTabsStore } = await import(/* @vite-ignore */ tabModule)
      for (const path of paths) await useTabsStore().open(path, { newTab: true })
    }, [notes[0]!, notes[2]!])
    await tab(notes[1]!).getByRole('button').first().click({ button: 'right' })
    await page.getByTestId('tab-menu-others').click()
    await expect(page.getByTestId('tab')).toHaveCount(1)
    await tab(notes[1]!).getByRole('button').first().click({ button: 'right' })
    await expect(page.getByTestId('tab-menu-left')).toBeDisabled()
    await expect(page.getByTestId('tab-menu-right')).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.evaluate(async path => {
      const tabModule = '/src/stores/tabs.ts'; const { useTabsStore } = await import(/* @vite-ignore */ tabModule)
      const pendingModule = '/src/utils/pendingEdits.ts'; const { registerPendingEditor } = await import(/* @vite-ignore */ pendingModule)
      await useTabsStore().open(path, { newTab: true })
      ;(window as unknown as { __removeEditor: () => void }).__removeEditor = registerPendingEditor(() => path, async () => { throw new Error('测试保存失败') })
    }, notes[0]!)
    await tab(notes[1]!).getByRole('button').first().click({ button: 'right' })
    await page.getByTestId('tab-menu-others').click()
    await expect(page.getByTestId('tab')).toHaveCount(2)
    await expect(page.getByTestId('toast').filter({ hasText: '测试保存失败' })).toBeVisible()
    await page.evaluate(() => (window as unknown as { __removeEditor: () => void }).__removeEditor())
    await page.keyboard.press('Control+l')
    await selectOption(page, 'agent-model', 'responses-model')
    await expect(page.getByTestId('agent-model')).toHaveAttribute('data-value', 'responses-model')
    await page.getByTestId('agent-input').fill('第一轮：记录我的测试目标')
    await page.getByTestId('agent-send').click()
    await expect(page.getByTestId('agent-stop')).toHaveCount(0)
    await expect(page.getByTestId('agent-answer')).toHaveCount(1)
    await expect(page.getByTestId('agent-answer')).toContainText('好')
    await expect(page.getByTestId('agent-stop')).toHaveCount(0)
    const id = (await app.call('agent:conversations', {})).items[0]!.conversationId
    await expect.poll(() => app.core.agent.get(id).context?.modelId).toBe('responses-model')
    await selectOption(page, 'agent-model', 'follow')
    app.fake.setResponder(() => '已接续上一轮')
    await page.getByTestId('agent-input').fill('第二轮：继续')
    await page.getByTestId('agent-send').click()
    await expect(page.getByTestId('agent-answer')).toHaveCount(2)
    await expect(page.getByTestId('agent-answer').last()).toContainText('已接续上一轮')
    await expect(page.getByTestId('agent-stop')).toHaveCount(0)
    expect(JSON.stringify(app.fake.requests.at(-1)?.messages)).toContain('记录我的测试目标')
    await page.reload()
    await page.keyboard.press('Control+l')
    await page.getByTestId('agent-history').click()
    await page.getByText('第一轮：记录我的测试目标', { exact: true }).first().click()
    await expect(page.getByTestId('agent-model')).toHaveAttribute('data-value', 'follow')
  } finally { await fixtureApp.close() }
})
for (const protocol of ['openai-responses', 'anthropic-messages'] as const) {
  test('Chrome：' + protocol + ' 获取模型、搜索多选、去重、草稿保存与手动添加', async ({ page }) => {
    const fixtureApp = await fixture(), { app } = fixtureApp
    const models = await startModelList(() => ({ body: { data: [
      { id: 'fake', display_name: '已配置模型' }, { id: 'vendor/alpha', display_name: 'Alpha 模型' },
      { id: 'vendor/beta', display_name: 'Beta 模型' }, { id: 'vendor/gamma', display_name: 'Gamma 模型' },
    ] } }))
    const before = app.core.settings.get().models
    try {
      await page.goto(fixtureApp.url)
      await selectOption(page, 'model-protocol', protocol)
      await page.getByTestId('model-base-url').fill(models.baseUrl)
      await page.getByTestId('model-api-key').fill('discovery-unsaved-key')
      await page.getByTestId('model-fetch').click()
      await expect(page.locator('[data-discovered-model]')).toHaveCount(4)
      const search = page.getByTestId('model-discovery-search')
      await expect(page.getByRole('checkbox', { name: 'fake', exact: true })).toBeDisabled()
      await expect(page.getByRole('checkbox', { name: 'fake', exact: true })).toBeChecked()
      expect(app.core.settings.get().models).toEqual(before)
      await search.fill('alpha')
      await expect(page.locator('[data-discovered-model]')).toHaveCount(1)
      await page.getByTestId('model-discovery-select-visible').click()
      await search.fill('Beta')
      await page.getByRole('checkbox', { name: 'vendor/beta', exact: true }).check()
      await search.fill('no-match')
      await expect(page.getByText('没有匹配的模型', { exact: true })).toBeVisible()
      await search.clear()
      await expect(page.getByTestId('model-discovery-add')).toContainText('2')
      await page.setViewportSize({ width: 420, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await page.locator('.discovery-item').first().evaluate(element => getComputedStyle(element).display)).toBe('flex')
      await page.screenshot({ path: test.info().outputPath('model-discovery.png'), fullPage: true })
      await page.getByTestId('model-discovery-add').click()
      await expect(page.getByTestId('model-discovery')).toHaveCount(0)
      expect(app.core.settings.get().models).toEqual(before)
      await page.getByTestId('model-save').click()
      await expect.poll(() => app.core.settings.get().models.channels[0]!.models.length).toBe(3)
      expect(app.core.settings.get().models.defaultModelId).toBe(before.defaultModelId)
      expect(app.core.settings.get().models.channels[0]!.models.map(model => model.model)).toEqual(['fake', 'vendor/alpha', 'vendor/beta'])
      await page.getByTestId('model-fetch').click()
      await expect(page.getByRole('checkbox', { name: 'vendor/alpha', exact: true })).toBeDisabled()
      await expect(page.getByRole('checkbox', { name: 'vendor/beta', exact: true })).toBeDisabled()
      await page.getByRole('checkbox', { name: 'vendor/gamma', exact: true }).check()
      await page.getByRole('dialog', { name: '获取模型' }).getByRole('button', { name: '取消', exact: true }).click()
      expect(app.core.settings.get().models.channels[0]!.models).toHaveLength(3)
      models.setResponder(() => ({ status: 404, body: { error: 'fixture-only' } }))
      await page.getByTestId('model-fetch').click()
      await expect(page.getByTestId('model-discovery-error')).toContainText('HTTP 404')
      await page.getByRole('dialog', { name: '获取模型' }).getByRole('button', { name: '取消', exact: true }).click()
      await page.getByTestId('model-add').click()
      await page.getByTestId('model-name').fill('manual-model')
      await page.getByTestId('model-save').click()
      await expect.poll(() => app.core.settings.get().models.channels[0]!.models.length).toBe(4)
      expect(new URL(models.requests[0]!.url, models.baseUrl).pathname).toBe('/v1/models')
      if (protocol === 'anthropic-messages') expect(models.requests[0]!.headers['x-api-key']).toBe('discovery-unsaved-key')
      else expect(models.requests[0]!.headers.authorization).toBe('Bearer discovery-unsaved-key')
    } finally { await models.close(); await fixtureApp.close() }
  })
}
