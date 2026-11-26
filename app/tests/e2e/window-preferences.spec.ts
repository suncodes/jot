import { expect, test } from './file-fixture'
import { selectOption } from './helpers'

test('关闭窗口偏好：默认进入后台，选择直接退出后关闭整个软件', async ({ jot }) => {
  const { page, call, launched } = jot
  const mainVisible = () => launched.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html'))?.isVisible() ?? false,
  )
  const closeMain = () => launched.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html'))?.close(),
  )

  await page.getByTestId('ribbon-settings').click()
  await page.getByTestId('settings-nav-appearance').click()
  await expect(page.getByTestId('settings-close-behavior')).toHaveAttribute('data-value', 'tray')

  await closeMain()
  await expect.poll(mainVisible).toBe(false)
  await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html'))?.show())
  await expect.poll(mainVisible).toBe(true)

  await selectOption(page, 'settings-close-behavior', 'quit')
  await expect(page.getByTestId('settings-close-behavior')).toHaveAttribute('data-value', 'quit')
  expect((await call('settings:get', undefined)).window.closeBehavior).toBe('quit')

  let exited = false
  launched.app.process().once('exit', () => { exited = true })
  await closeMain().catch(() => undefined)
  await expect.poll(() => exited).toBe(true)
})
