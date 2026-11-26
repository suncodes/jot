import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseMaintenance, StorageUsage, TemporaryCleanup } from '@shared/maintenance'
import type { TrashItem } from '@shared/types'
import { JotError } from '@shared/result'
import type { VaultService } from '../vault/vault'
import type { IndexService } from '../index/index'
import type { StateStore } from '../state/state'
import type { SettingsService } from '../settings/settings'
import { atomicTemporaryTarget, isAtomicWriteActive } from '../util/fs'
import { isCalendarDay, optionalActivityTime } from '../util/time'
import { DIRS, resolveInVault, toRel } from '../vault/paths'

const DAY = 24 * 60 * 60 * 1000
const CHECK_INTERVAL = 10 * 60 * 1000
interface TemporaryFile { file: string; root: string; size: number; eligible: boolean }
interface MaintenanceDeps {
  vault: VaultService
  index: IndexService
  state: StateStore
  settings: SettingsService
  userDataDir: string
  now: () => Date
  busy: (exceptConversationId?: string) => boolean
  idle: () => Promise<void>
  mutate: <T>(operation: () => Promise<T>) => Promise<T>
}

async function stat(file: string): Promise<fs.Stats | null> {
  try { return await fs.promises.lstat(file) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
/** 只枚举实际文件，不跟随目录联接或符号链接。 */
async function walk(file: string, visit: (file: string, info: fs.Stats) => Promise<void>, temporaryOnly = false, excluded?: string): Promise<void> {
  if (excluded) {
    const relative = path.relative(excluded, file)
    if (relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) return
  }
  const info = await stat(file)
  if (!info || info.isSymbolicLink()) return
  if (info.isFile()) { await visit(file, info); return }
  if (!info.isDirectory()) return
  let dir: fs.Dir
  try { dir = await fs.promises.opendir(file) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  for await (const entry of dir) if (!entry.isSymbolicLink() && (entry.isDirectory() || !temporaryOnly || atomicTemporaryTarget(entry.name))) {
    await walk(path.join(file, entry.name), visit, temporaryOnly, excluded)
  }
}

export class MaintenanceService {
  private checkedAt: number | null = null
  constructor(private readonly deps: MaintenanceDeps) {}
  reset(): void { this.checkedAt = null }

  private assertOpen(expectedRoot?: string): string {
    const { vault, state, index } = this.deps
    if (!vault.isOpen || !state.isOpen || !index.isOpen) throw new JotError('VAULT_NOT_OPEN', '还没有打开库')
    if (expectedRoot && expectedRoot !== vault.path) throw new JotError('CONFLICT', '当前库已切换，请刷新维护信息后再操作')
    return vault.path
  }
  private async size(file: string, excludeTemporary = true): Promise<number> {
    let bytes = 0
    await walk(file, async (name, info) => { if (!excludeTemporary || !atomicTemporaryTarget(name)) bytes += info.size })
    return bytes
  }
  private expired(item: Pick<TrashItem, 'deletedAt'>): boolean {
    const deletedAt = optionalActivityTime(item.deletedAt)
    return !!deletedAt && !isCalendarDay(deletedAt) && Date.parse(deletedAt) <= this.deps.now().getTime() - 30 * DAY
  }
  private async eligible(file: string, info: fs.Stats, root: string): Promise<boolean> {
    if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs > this.deps.now().getTime() - DAY || isAtomicWriteActive(file)) return false
    const target = atomicTemporaryTarget(file)
    if (!target) return false
    resolveInVault(root, toRel(root, file))
    resolveInVault(root, toRel(root, target))
    const final = await stat(target)
    return !!final?.isFile() && !final.isSymbolicLink()
  }
  private async temporary(root: string): Promise<TemporaryFile[]> {
    const found = new Map<string, TemporaryFile>()
    const roots = [
      ...[DIRS.content, DIRS.ideas, DIRS.inbox, DIRS.journal, DIRS.wiki, DIRS.meta].map(dir => path.join(root, dir)),
      this.deps.userDataDir,
    ]
    for (const directory of roots) await walk(directory, async (file, info) => {
      if (!atomicTemporaryTarget(file)) return
      const key = process.platform === 'win32' ? file.toLowerCase() : file
      if (!found.has(key)) found.set(key, { file, root: directory, size: info.size, eligible: await this.eligible(file, info, directory) })
    }, true, path.join(root, DIRS.trash))
    return [...found.values()]
  }

  async usage(): Promise<StorageUsage> {
    const root = this.assertOpen()
    const { state, index } = this.deps
    const conversations = state.raw.prepare('SELECT (SELECT COUNT(*) FROM conversations) AS count, (SELECT COUNT(*) FROM messages) AS messages').get() as StorageUsage['conversations']
    const databases = [index.databaseUsage(), state.databaseUsage()]
    const [content, derived, configuration, trashBytes, trash, temporary] = await Promise.all([
      Promise.all([DIRS.content, DIRS.ideas, DIRS.inbox, DIRS.templates].map(dir => this.size(path.join(root, dir)))),
      Promise.all([DIRS.journal, DIRS.wiki].map(dir => this.size(path.join(root, dir)))),
      Promise.all([
        this.size(path.join(root, DIRS.skills)), this.size(path.join(root, DIRS.plugins)),
        this.size(path.join(root, DIRS.appExtensions)),
        this.size(path.join(root, DIRS.meta, 'app-extensions.json')), this.size(path.join(root, DIRS.meta, 'shortcuts.json')),
        this.size(path.join(root, DIRS.meta, 'assistant.json')),
        this.size(path.join(this.deps.userDataDir, 'settings.json')), this.size(path.join(this.deps.userDataDir, 'pi', 'models.json')),
        this.size(path.join(this.deps.userDataDir, 'pi', 'auth.json')),
      ]),
      this.size(path.join(root, DIRS.trash), false),
      this.deps.vault.trashList({ limit: Number.MAX_SAFE_INTEGER }),
      this.temporary(root),
    ])
    return {
      vaultPath: root, contentBytes: content.reduce((a, b) => a + b, 0), derivedBytes: derived.reduce((a, b) => a + b, 0),
      configurationBytes: configuration.reduce((a, b) => a + b, 0), conversations, databases,
      trash: { items: trash.total, bytes: trashBytes, expiredItems: trash.items.filter(item => this.expired(item)).length },
      temporary: {
        files: temporary.filter(item => item.eligible).length,
        bytes: temporary.filter(item => item.eligible).reduce((sum, item) => sum + item.size, 0),
        retainedFiles: temporary.filter(item => !item.eligible).length,
        retainedBytes: temporary.filter(item => !item.eligible).reduce((sum, item) => sum + item.size, 0),
      },
    }
  }

  /** 删除前再次检查当前库、真实位置、年龄、最终文件和在用状态。 */
  private async cleanTemporary(root: string): Promise<TemporaryCleanup> {
    const result: TemporaryCleanup = { removed: 0, freedBytes: 0, failures: [] }
    for (const item of await this.temporary(root)) {
      if (!item.eligible) continue
      try {
        this.assertOpen(root)
        const current = await stat(item.file)
        if (!current || !await this.eligible(item.file, current, item.root)) continue
        await fs.promises.unlink(item.file)
        result.removed++; result.freedBytes += current.size
      } catch (error) {
        result.failures.push({ path: toRel(item.root, item.file), message: error instanceof Error ? error.message : String(error) })
      }
    }
    return result
  }
  async clearTemporary(expectedRoot: string): Promise<TemporaryCleanup> {
    return this.deps.mutate(async () => this.cleanTemporary(this.assertOpen(expectedRoot)))
  }

  async optimizeDatabases(expectedRoot: string, exceptConversationId?: string): Promise<DatabaseMaintenance> {
    await this.deps.idle()
    return this.deps.mutate(async () => {
      this.assertOpen(expectedRoot)
      if (this.deps.busy(exceptConversationId)) throw new JotError('CONFLICT', '仍有其他任务或助手在运行，请稍后再维护数据库')
      const result: DatabaseMaintenance = { freedBytes: 0, failures: [] }
      for (const database of [this.deps.index, this.deps.state]) {
        const kind = database.databaseUsage().kind
        try { result.freedBytes += database.maintainStorage(true) }
        catch (error) { result.failures.push({ database: kind, message: error instanceof Error ? error.message : String(error) }) }
      }
      return result
    })
  }

  /** 启动与在线定时共用；繁忙时推迟，普通内容和会话不按期限删除。 */
  async tick(): Promise<void> {
    if (!this.deps.vault.isOpen || !this.deps.state.isOpen || !this.deps.index.isOpen || this.deps.busy()) return
    const now = this.deps.now().getTime()
    if (this.checkedAt !== null && now - this.checkedAt < CHECK_INTERVAL) return
    const firstCheck = this.checkedAt === null
    this.checkedAt = now
    await this.deps.idle()
    await this.deps.mutate(async () => {
      const root = this.assertOpen()
      if (this.deps.busy()) { this.checkedAt = null; return }
      if (this.deps.settings.get().maintenance.trashRetentionDays === 30) {
        try {
          const trash = await this.deps.vault.trashList({ limit: Number.MAX_SAFE_INTEGER })
          const expired = trash.items.filter(item => this.expired(item)).map(item => item.trashId)
          if (expired.length) await this.deps.vault.purgeTrash(expired, deletedAt => this.deps.settings.get().maintenance.trashRetentionDays === 30 && this.expired({ deletedAt }))
        } catch (error) { console.warn('[maintenance] 回收清理未完成：', error instanceof Error ? error.message : error) }
      }
      const temporary = await this.cleanTemporary(root)
      if (temporary.failures.length) console.warn('[maintenance] 临时文件清理未完成：', temporary.failures)
      if (this.deps.busy()) return
      for (const database of [this.deps.index, this.deps.state]) {
        try { database.maintainStorage(!firstCheck, true) }
        catch (error) { console.warn('[maintenance] 数据库维护已推迟：', error instanceof Error ? error.message : error) }
      }
    })
  }
}
