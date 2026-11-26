import path from 'node:path'
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, safeStorage, screen, shell, Tray } from 'electron'
import type { EventContract, EventName } from '@shared/ipc'
import type { WindowCloseBehavior } from '@shared/types'
import { JotError } from '@shared/result'
import { Core } from './core'
import { loadDevModelDefaults } from './env'
import { createHandlers, type Platform } from './ipc/handlers'
import { registerIpc } from './ipc/register'
import { createSecretStore } from './settings/secrets'

// 测试时用独立的数据目录，互不干扰
if (process.env.JOT_USER_DATA) app.setPath('userData', path.resolve(process.env.JOT_USER_DATA))

const isDev = !app.isPackaged
const appRoot = app.getAppPath()
const preloadPath = path.join(import.meta.dirname, '../preload/index.cjs')
const webPreferences = { preload: preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false }

const CAPTURE_WIDTH = 600
const CAPTURE_MIN_HEIGHT = 56

let mainWindow: BrowserWindow | null = null
let captureWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let registeredHotkey: string | null = null
let closeBehavior: WindowCloseBehavior = 'tray'

function load(win: BrowserWindow, page: string): void {
  const devServer = process.env.ELECTRON_RENDERER_URL
  if (isDev && devServer) void win.loadURL(`${devServer}/${page}`)
  else void win.loadFile(path.join(import.meta.dirname, '../renderer', page))
}

function send<E extends EventName>(event: E, data: EventContract[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(event, data)
  }
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Jot',
    icon: path.join(appRoot, 'resources/icon.png'),
    autoHideMenuBar: true,
    webPreferences,
  })
  win.once('ready-to-show', () => win.show())
  // 默认收进托盘；用户可在设置中改为直接退出。
  win.on('close', (e) => {
    if (quitting) return
    if (closeBehavior === 'quit') { quitApplication(); return }
    e.preventDefault()
    win.hide()
  })
  // 外部链接用系统浏览器打开，不在软件窗口里跳转
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
  load(win, 'index.html')
  return win
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function quitApplication(): void {
  if (quitting) return
  quitting = true
  app.quit()
}

/** 快捷记录小窗：启动时就建好并隐藏，按快捷键时只需要显示，保证弹出速度 */
function createCaptureWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: CAPTURE_WIDTH,
    height: CAPTURE_MIN_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    transparent: true,
    hasShadow: true,
    title: '记一条',
    webPreferences,
  })
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
  })
  load(win, 'capture.html')
  return win
}

function showCapture(): void {
  if (!captureWindow || captureWindow.isDestroyed()) captureWindow = createCaptureWindow()
  const win = captureWindow
  if (!win.isVisible()) {
    // 出现在鼠标所在的显示器上：水平居中，距顶部约 22%
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    win.setPosition(Math.round(area.x + (area.width - CAPTURE_WIDTH) / 2), Math.round(area.y + area.height * 0.22))
  }
  win.show()
  win.focus()
  win.webContents.send('capture:shown', null)
}

function registerHotkey(hotkey: string): void {
  if (registeredHotkey === hotkey) return
  if (registeredHotkey) globalShortcut.unregister(registeredHotkey)
  registeredHotkey = null
  let okRegistered = false
  try {
    okRegistered = globalShortcut.register(hotkey, showCapture)
  } catch {
    okRegistered = false
  }
  if (okRegistered) registeredHotkey = hotkey
  else send('hotkey:conflict', { hotkey })
}

function createTray(): void {
  const icon = nativeImage.createFromPath(path.join(appRoot, 'resources/icon.png')).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('Jot')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主窗口', click: showMainWindow },
      { label: '记一条', click: showCapture },
      { type: 'separator' },
      { label: '退出', click: quitApplication },
    ]),
  )
  tray.on('click', showMainWindow)
}

async function bootstrap(): Promise<void> {
  const secrets = createSecretStore(safeStorage)

  // 自动化测试用：指定软件认为的当前时间（之后照常往前走），这样不用真的等到晚上九点半
  const testNow = process.env.JOT_USER_DATA && process.env.JOT_TEST_NOW ? Date.parse(process.env.JOT_TEST_NOW) : NaN
  const startedAt = Date.now()
  const core = new Core({
    now: Number.isNaN(testNow) ? undefined : () => new Date(testNow + (Date.now() - startedAt)),
    userDataDir: app.getPath('userData'),
    bundledPluginRoot: app.isPackaged ? path.join(process.resourcesPath, 'plugins') : path.join(appRoot, 'resources/plugins'),
    bundledAppExtensionRoot: app.isPackaged ? path.join(process.resourcesPath, 'app-extensions') : path.join(appRoot, 'resources/app-extensions'),
    secrets,
    devModel: isDev ? loadDevModelDefaults(path.resolve(appRoot, '..')) : null,
    emit: send,
    systemDarkMode: () => nativeTheme.shouldUseDarkColors,
  })
  await core.init()
  closeBehavior = core.settings.get().window.closeBehavior

  const platform: Platform = {
    appInfo: () => ({ version: app.getVersion(), dev: isDev, platform: process.platform }),
    async pickFiles() {
      const options: Electron.OpenDialogOptions = { title: '选择要导入的文件', properties: ['openFile', 'multiSelections'] }
      const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : result.filePaths
    },
    async pickDirectory(purpose) {
      const properties: Electron.OpenDialogOptions['properties'] = purpose ? ['openDirectory'] : ['openDirectory', 'createDirectory']
      const options = { title: purpose === 'plugin' ? '选择包含 plugin.json 的插件目录' : purpose === 'skill' ? '选择包含 SKILL.md 的技能目录' : purpose === 'extension' ? '选择包含 extension.json 的应用插件目录' : '选择库的位置', properties }
      const r = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
      return r.canceled ? null : (r.filePaths[0] ?? null)
    },
    async saveFile({ defaultPath, format }) {
      const options: Electron.SaveDialogOptions = { title: '导出对话', defaultPath,
        filters: [{ name: format === 'markdown' ? 'Markdown' : 'JSONL', extensions: [format === 'markdown' ? 'md' : 'jsonl'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'] }
      const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
      return result.canceled ? null : result.filePath ?? null
    },
    hideCapture: () => captureWindow?.hide(),
    resizeCapture(height) {
      if (!captureWindow || captureWindow.isDestroyed()) return
      const [x = 0, y = 0] = captureWindow.getPosition()
      // 小窗不可手动缩放，这里用 setBounds 才能改高度
      captureWindow.setBounds({ x, y, width: CAPTURE_WIDTH, height: Math.round(Math.max(CAPTURE_MIN_HEIGHT, height)) })
    },
    trashItem: absolute => shell.trashItem(absolute),
    async openExternal(absPath) {
      const problem = await shell.openPath(absPath)
      if (problem) throw new JotError('IO_ERROR', `打不开文件：${problem}`)
    },
  }
  registerIpc(ipcMain, createHandlers(core, platform))

  createTray()
  captureWindow = createCaptureWindow()
  showMainWindow()

  // 主窗口加载完再注册快捷键，这样冲突提示能送到界面
  mainWindow?.webContents.once('did-finish-load', () => registerHotkey(core.settings.get().capture.hotkey))
  core.settings.onChange((s) => {
    closeBehavior = s.window.closeBehavior
    registerHotkey(s.capture.hotkey)
  })

  // 使用独立测试数据目录时，打包冒烟也不改系统登录项。
  const applyLoginItem = (enabled: boolean) => {
    if (app.isPackaged && !process.env.JOT_USER_DATA) app.setLoginItemSettings({ openAtLogin: enabled })
  }
  applyLoginItem(core.settings.get().capture.launchAtLogin)
  core.settings.onChange((s) => applyLoginItem(s.capture.launchAtLogin))

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    void core.dispose()
  })

  // 自动化测试用：从主进程触发小窗，等同于按下全局快捷键
  if (process.env.JOT_USER_DATA) {
    ;(globalThis as Record<string, unknown>).__jotTest = { showCapture, hotkey: () => registeredHotkey, tick: () => core.daily.tick() }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)
  app.on('before-quit', () => {
    quitting = true
  })
  // 主窗口关闭后软件留在托盘，不随窗口退出
  app.on('window-all-closed', () => {})
  app
    .whenReady()
    .then(bootstrap)
    .catch((e) => {
      console.error('[main] 启动失败：', e)
      dialog.showErrorBox('Jot 启动失败', e instanceof JotError ? e.message : String(e?.stack ?? e))
      app.exit(1)
    })
}
