import path from 'node:path'
import { test, expect } from '@playwright/test'
import vue from '@vitejs/plugin-vue'
import { createServer } from 'vite'
import { testApp } from '../helpers/test-app'
import { startProtocolLlm } from '../helpers/fake-protocols'
import type { Channel } from '../../shared/ipc'
import { selectOption } from './helpers'

test('Chrome：共用模型表单选择协议、未保存测试、草稿保留、窄窗与重新加载', async ({ page, browser }) => {
  expect(browser.browserType().name()).toBe('chromium')
  const app = await testApp()
  const responses = await startProtocolLlm('openai-responses'), anthropic = await startProtocolLlm('anthropic-messages')
  const root = path.resolve(import.meta.dirname, '../..')
  const server = await createServer({
    configFile: false, root,
    plugins: [vue(), {
      name: 'jot-test-ipc',
      configureServer({ middlewares }) {
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
  try {
    await server.listen()
    const url = server.resolvedUrls!.local[0]! + 'tests/chrome/model-form.html'
    await page.goto(url)
    await expect(page.getByTestId('model-protocol')).toHaveText('OpenAI Chat Completions')
    await selectOption(page, 'model-protocol', 'openai-responses')
    await page.getByTestId('model-base-url').fill(responses.baseUrl)
    await page.getByTestId('model-name').fill('fixture-responses')
    await page.getByTestId('model-api-key').fill('fixture-key')
    await page.getByTestId('model-test').click()
    await expect(page.getByTestId('model-test-result')).toHaveAttribute('data-ok', 'true')
    expect(app.core.settings.get().model.protocol).toBe('openai-completions')
    await page.getByTestId('model-advanced').locator('summary').click()
    await selectOption(page, 'model-context-window', '65536')
    await selectOption(page, 'model-reasoning-effort', 'high')
    await page.getByTestId('model-save').click()
    await expect.poll(() => app.core.settings.get().model.protocol).toBe('openai-responses')
    await page.reload()
    await expect(page.getByTestId('model-protocol')).toHaveText('OpenAI Responses')
    await page.getByTestId('model-advanced').locator('summary').click()
    await expect(page.getByTestId('model-context-window')).toHaveAttribute('data-value', '65536')
    await selectOption(page, 'model-protocol', 'anthropic-messages')
    await expect(page.getByTestId('model-context-window')).toHaveAttribute('data-value', 'auto')
    await expect(page.getByTestId('model-reasoning-effort')).toHaveAttribute('data-value', 'auto')
    await page.getByTestId('model-base-url').fill(anthropic.baseUrl)
    await page.getByTestId('model-name').fill('fixture-anthropic')
    await page.getByTestId('model-api-key').fill('fixture-key')
    await page.getByTestId('model-test').click()
    await expect(page.getByTestId('model-test-result')).toHaveAttribute('data-ok', 'true')
    await page.getByTestId('model-save').click()
    await expect.poll(() => app.core.settings.get().model.protocol).toBe('anthropic-messages')
    await page.setViewportSize({ width: 420, height: 820 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.getByTestId('model-protocol')).toBeVisible()
    await page.screenshot({ path: '../tmp/model-protocol-chrome.png', fullPage: true })
    expect(responses.wireRequests.length).toBeGreaterThan(0)
    expect(anthropic.wireRequests.length).toBeGreaterThan(0)
  } finally { await server.close(); await responses.close(); await anthropic.close(); await app.close() }
})
