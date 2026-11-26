// 安装依赖后确认 Electron 的二进制已经下载。
// 使用官方分发源；需要镜像时由开发者通过 ELECTRON_MIRROR 环境变量指定。
import fs from 'node:fs'
import path from 'node:path'

const electronDir = path.resolve(import.meta.dirname, '../node_modules/electron')
const binary = path.join(electronDir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

if (fs.existsSync(electronDir) && !fs.existsSync(binary)) {
  console.log('[setup] 正在下载 Electron…')
  await import('../node_modules/electron/install.js')
}
