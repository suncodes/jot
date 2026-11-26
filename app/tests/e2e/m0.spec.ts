import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { startFakeLlm } from '../helpers/fake-llm'
import { selectOption, cleanup, launch, shot } from './helpers'

// M0 的完成标志：能启动，能创建库，模型能用配置的接口回一句话。

test('首次启动：建库、测试模型、进入主界面；重启后直接进入主界面', async () => {
  const fake = await startFakeLlm(() => '好')
  const first = await launch({ llmBaseUrl: fake.baseUrl })
  const vaultDir = path.join(first.workDir, '我的库')
  try {
    const { page } = first
    await expect(page.getByTestId('onboarding')).toBeVisible()
    await shot(page, 'm0-onboarding-vault')

    // 第一步：选择库的位置
    await page.getByTestId('vault-path').fill(vaultDir)
    await page.getByTestId('vault-use').click()

    // 第二步：模型。开发配置里已有模型，测试连接应当成功
    await expect(page.getByTestId('dev-model')).toBeVisible()
    await page.getByTestId('model-test').click()
    await expect(page.getByTestId('model-test-result')).toHaveAttribute('data-ok', 'true')
    expect(fake.requests.length).toBe(1)
    expect(fake.requests[0]!.model).toBe('fake-model')
    await shot(page, 'm0-onboarding-model')
    await page.getByTestId('model-next').click()

    // 第三步：进入主界面
    await page.getByTestId('onboarding-start').click()
    await expect(page.getByTestId('shell')).toBeVisible()
    for (const id of ['ribbon', 'side-panel', 'content', 'statusbar']) {
      await expect(page.getByTestId(id)).toBeVisible()
    }
    await expect(page.getByTestId('model-status')).toHaveAttribute('data-state', 'ok')
    await shot(page, 'm0-shell')

    // 库的固定目录已创建
    for (const d of ['inbox', 'notes', 'files', 'journal', 'wiki/sources', 'projects', '.jot']) {
      expect(fs.statSync(path.join(vaultDir, d)).isDirectory()).toBe(true)
    }

    // 顶部两个主入口，分类可以显式折叠；助手默认按需打开。
    await expect(page.getByTestId('ribbon').getByRole('button')).toHaveText(['时间线', '内容库'])
    await page.getByTestId('side-toggle').click()
    await expect(page.getByTestId('side-panel')).toBeHidden()
    await page.getByTestId('side-toggle').click()
    await expect(page.getByTestId('side-panel')).toBeVisible()
    await expect(page.getByTestId('agent-panel')).toHaveCount(0)
    await page.getByTestId('agent-open').click()
    await expect(page.getByTestId('agent-panel')).toBeVisible()
    await page.getByTestId('agent-close').click()
    await expect(page.getByTestId('agent-panel')).toHaveCount(0)
    // 设置：显示库的位置；切换到浅色主题立即生效
    await page.getByTestId('ribbon-settings').click()
    await expect(page.getByTestId('settings-vault-path')).toHaveText(vaultDir)
    await selectOption(page, 'settings-theme', 'light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await shot(page, 'm0-settings-light')
    await selectOption(page, 'settings-theme', 'dark')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await shot(page, 'm0-settings-dark')
    await selectOption(page, 'settings-theme', 'light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  } finally {
    await first.close()
  }

  // 重启：不再出现引导，主题和库都记住了
  const second = await launch({ llmBaseUrl: fake.baseUrl, reuse: first })
  try {
    await expect(second.page.getByTestId('shell')).toBeVisible()
    await expect(second.page.getByTestId('onboarding')).toHaveCount(0)
    await expect(second.page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(second.page.getByTestId('statusbar')).toContainText('我的库')
  } finally {
    await second.close()
    await fake.close()
    cleanup(first.userData, first.workDir)
  }
})

test('没有配置模型也能进入主界面，状态栏提示模型未配置', async () => {
  const launched = await launch()
  try {
    const { page } = launched
    await page.getByTestId('vault-path').fill(path.join(launched.workDir, 'vault'))
    await page.getByTestId('vault-use').click()
    await expect(page.getByTestId('dev-model')).toHaveCount(0)

    // 没填地址就测试：给出提示，不报错
    await page.getByTestId('model-test').click()
    await expect(page.getByTestId('model-test-result')).toHaveAttribute('data-ok', 'false')

    await page.getByTestId('model-skip').click()
    await page.getByTestId('onboarding-start').click()
    await expect(page.getByTestId('shell')).toBeVisible()
    await expect(page.getByTestId('model-status')).toHaveAttribute('data-state', 'not-configured')
  } finally {
    await launched.close()
    cleanup(launched.userData, launched.workDir)
  }
})

test('库的位置无效时在引导页显示原因', async () => {
  const launched = await launch()
  try {
    const { page } = launched
    await page.getByTestId('vault-path').fill('不是完整路径')
    await page.getByTestId('vault-use').click()
    await expect(page.getByTestId('onboarding-error')).toContainText('完整路径')
    await expect(page.getByTestId('onboarding')).toBeVisible()
  } finally {
    await launched.close()
    cleanup(launched.userData, launched.workDir)
  }
})

test('界面进程不能直接访问 Node，只能通过白名单通道', async () => {
  const launched = await launch()
  try {
    const result = await launched.page.evaluate(async () => {
      const w = window as unknown as Record<string, unknown>
      let unknownChannel = ''
      try {
        await (window.jot.invoke as (c: string) => Promise<unknown>)('fs:readFile')
      } catch (e) {
        unknownChannel = String(e)
      }
      return { hasRequire: typeof w.require, hasProcess: typeof w.process, bridge: Object.keys(window.jot).sort(), unknownChannel }
    })
    expect(result.hasRequire).toBe('undefined')
    expect(result.hasProcess).toBe('undefined')
    expect(result.bridge).toEqual(['invoke', 'on', 'pathForFile'])
    expect(result.unknownChannel).toContain('未知的通道')
  } finally {
    await launched.close()
    cleanup(launched.userData, launched.workDir)
  }
})
