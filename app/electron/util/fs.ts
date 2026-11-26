import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import fs from 'node:fs'
import path from 'node:path'

const atomicWrites = new Set<string>()
const atomicKey = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
const temporaryPattern = /^\.jot-write\.(.+)\.[0-9]+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/

/** 独立命名空间标明 Jot 临时写入；最终文件缺失的残留不作自动清理。 */
export function atomicTemporaryTarget(file: string): string | null {
  const name = temporaryPattern.exec(path.basename(file))?.[1]
  return name && name !== '.' && name !== '..' ? path.join(path.dirname(file), name) : null
}
export function isAtomicWriteActive(file: string): boolean { return atomicWrites.has(atomicKey(file)) }

/** 先写临时文件再改名；在用标记贯穿写入、重试和失败后的清理。 */
export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), '.jot-write.' + path.basename(file) + '.' + process.pid + '.' + randomUUID() + '.tmp')
  atomicWrites.add(atomicKey(tmp))
  let committed = false
  try {
    await fs.promises.writeFile(tmp, data)
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(tmp, file)
        committed = true
        break
      } catch (error) {
        // Windows 的索引、预览或杀毒短暂持有读句柄；有限重试，持久失败照常抛出。
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 4) throw error
        await delay(10 * (attempt + 1))
      }
    }
  } finally {
    try {
      if (!committed) await fs.promises.rm(tmp, { force: true }).catch(() => {})
    } finally { atomicWrites.delete(atomicKey(tmp)) }
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n')
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p)
    return true
  } catch {
    return false
  }
}

/** 删除一个文件，不存在时不报错。不用 fs.rmSync：部分 Node 版本用它删中文名的文件会静默失败。 */
export function removeFileSync(file: string): void {
  try {
    fs.unlinkSync(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}
