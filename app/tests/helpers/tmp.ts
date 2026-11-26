import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 今天中午。测试里把它当作“现在”，这样不管测试在几点跑，都不会碰上晚上的自动日总结 */
export function noon(): Date {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  return d
}

/** 建一个临时目录，测试结束后用返回的 cleanup 删除 */
export function makeTmpDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jot-${prefix}-`))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}
