import fs from 'node:fs'
import { z } from 'zod'
import { mappedPath, type LibraryPin, type PathChange } from '@shared/files'
import { JotError } from '@shared/result'
import type { VaultService } from '../vault/vault'
import { normalizeRel } from '../vault/paths'
import { isSidecar } from '../vault/metadata'
import { writeJson } from '../util/fs'

const target = z.object({ path: z.string().min(1).max(1000), kind: z.enum(['file', 'folder']) }).strict()
const configuration = z.object({ pins: z.array(target) }).strict()
type PinTarget = z.infer<typeof target>
const same = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase()

/** 固定入口只保存当前相对路径和顺序，不参与内容归属或文件身份维护。调用方串行执行写入。 */
export class LibraryPins {
  private readonly file = '.jot/library-pins.json'
  constructor(private readonly vault: VaultService, private readonly changed: () => void) {}

  private path(input: PinTarget): string {
    const rel = normalizeRel(input.path)
    const root = input.kind === 'folder' ? /^content\//i : /^(content|ideas|inbox|journal|wiki)\//i
    if (!root.test(rel) || /^(?:[a-z]:|[/\\])/i.test(input.path) || input.path.replace(/\\/g, '/').split('/').includes('..')
      || rel.split('/').some(part => part.startsWith('.')) || isSidecar(rel)) {
      throw new JotError('INVALID_INPUT', '请选择内容库中的文件或内容目录')
    }
    return rel
  }

  private async read(): Promise<PinTarget[]> {
    let raw: string
    try { raw = await fs.promises.readFile(this.vault.abs(this.file), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new JotError('IO_ERROR', '无法读取固定入口配置')
    }
    try {
      const { pins } = configuration.parse(JSON.parse(raw))
      return pins.map(pin => ({ ...pin, path: this.path(pin) }))
    } catch { throw new JotError('INVALID_INPUT', '固定入口配置格式无效，请检查 ' + this.file) }
  }

  private available(pin: PinTarget): boolean {
    try {
      const parts = pin.path.split('/')
      for (let i = 1; i <= parts.length; i++) {
        if (fs.lstatSync(this.vault.abs(parts.slice(0, i).join('/')), { throwIfNoEntry: false })?.isSymbolicLink()) return false
      }
      const stat = fs.statSync(this.vault.abs(pin.path), { throwIfNoEntry: false })
      return pin.kind === 'folder' ? !!stat?.isDirectory() : !!stat?.isFile()
    } catch { return false }
  }

  private describe(pins: PinTarget[]): LibraryPin[] {
    return pins.map(pin => ({ ...pin, missing: !this.available(pin) }))
  }

  list(): Promise<LibraryPin[]> { return this.read().then(pins => this.describe(pins)) }

  private async save(pins: PinTarget[]): Promise<LibraryPin[]> {
    await writeJson(this.vault.abs(this.file), { pins })
    this.changed()
    return this.describe(pins)
  }

  async set(input: PinTarget & { pinned: boolean }): Promise<LibraryPin[]> {
    const pin = { kind: input.kind, path: this.path(input) }
    const pins = await this.read()
    const index = pins.findIndex(item => same(item.path, pin.path))
    if (!input.pinned) return index < 0 ? this.describe(pins) : this.save(pins.filter((_, i) => i !== index))
    if (!this.available(pin)) throw new JotError('NOT_FOUND', '文件或目录已不存在，无法固定')
    if (index >= 0) return this.describe(pins)
    return this.save([...pins, pin])
  }

  async reorder(path: string, direction: 'up' | 'down'): Promise<LibraryPin[]> {
    const pins = await this.read()
    const index = pins.findIndex(item => same(item.path, path))
    if (index < 0) throw new JotError('NOT_FOUND', '固定入口已移除')
    const next = index + (direction === 'up' ? -1 : 1)
    if (next < 0 || next >= pins.length) return this.describe(pins)
    ;[pins[index], pins[next]] = [pins[next]!, pins[index]!]
    return this.save(pins)
  }

  /** 只跟随本次应用内移动；移动到库外或目录展示范围之外后保留原路径，显示为失效入口。 */
  async move(changes: PathChange[]): Promise<void> {
    const pins = await this.read()
    let changed = false
    const mapped = pins.map(pin => {
      const next = mappedPath(pin.path, changes)
      if (next === pin.path) return pin
      try {
        const path = this.path({ ...pin, path: next })
        changed = true
        return { ...pin, path }
      } catch { return pin }
    })
    if (changed) await this.save(mapped.filter((pin, i) => mapped.findIndex(other => same(other.path, pin.path)) === i))
  }
}
