import fs from 'node:fs'
import path from 'node:path'

/** 今天中午。测试里把它当作“现在”，这样不管测试在几点跑，都不会碰上晚上的自动日总结 */
export function noon(): Date {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  return d
}

/** 建一个临时目录，测试结束后用返回的 cleanup 删除 */
export function makeTmpDir(prefix: string): { dir: string; cleanup: () => void } {
  const root = path.resolve(import.meta.dirname, '../../../tmp/tests')
  fs.mkdirSync(root, { recursive: true })
  const dir = fs.mkdtempSync(path.join(root, `jot-${prefix}-`))
  return { dir, cleanup: () => {
    if (!path.resolve(dir).startsWith(root + path.sep)) throw new Error('测试临时目录越界')
    fs.rmSync(dir, { recursive: true, force: true })
  } }
}
