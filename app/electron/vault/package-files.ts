import fs from 'node:fs'
import path from 'node:path'
import { isSkillName, MAX_SKILL_TEXT_BYTES } from '@shared/capabilities'
import { JotError } from '@shared/result'
import { writeFileAtomic } from '../util/fs'

const MAX_ENTRIES = 1000
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024

export interface PackageSnapshot { entries: PackageEntry[]; issues: Record<string, string> }
export interface PackageEntry { path: string; data: Buffer | null }
type PackageEntryFile = 'SKILL.md' | 'plugin.json' | 'extension.json'

export function packageSegments(relative: string): string[] {
  const parts = relative.split('/')
  if (parts.some(part => !part || /[. ]$|[<>:"|?*\\\x00-\x1f]/.test(part)
    || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))) {
    throw new JotError('INVALID_INPUT', '请使用包内相对路径')
  }
  return parts
}

async function statOrMissing(file: string) {
  try { return await fs.promises.lstat(file) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function directory(file: string): Promise<void> {
  if (!(await fs.promises.lstat(file)).isDirectory()) throw new JotError('INVALID_INPUT', '包内路径必须是实际文件夹，不能使用链接')
}

function decode(data: Buffer): string {
  if (data.includes(0)) throw new JotError('UNSUPPORTED_FORMAT', '包内资源必须是 UTF-8 文本')
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) }
  catch { throw new JotError('UNSUPPORTED_FORMAT', '包内资源必须是 UTF-8 文本') }
}

export function skillText(data: Buffer): string {
  if (data.byteLength > MAX_SKILL_TEXT_BYTES) throw new JotError('INVALID_INPUT', '包内文本超过 256 KiB')
  return decode(data)
}

export async function readPackage(source: string, entryFile: PackageEntryFile, issues?: Record<string, string>): Promise<PackageEntry[]> {
  await directory(source)
  const entry = await statOrMissing(path.join(source, entryFile))
  if (!entry?.isFile()) throw new JotError('INVALID_INPUT', '请选择包含 ' + entryFile + ' 的目录')
  if (entry.size > MAX_SKILL_TEXT_BYTES) throw new JotError('INVALID_INPUT', entryFile + ' 超过 256 KiB')
  const entries: PackageEntry[] = []
  const names = new Set<string>()
  let bytes = 0
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name
      packageSegments(rel)
      const key = rel.toLowerCase()
      if (names.has(key)) throw new JotError('INVALID_INPUT', '目录包含仅大小写不同的路径：' + rel)
      names.add(key)
      const absolute = path.join(dir, entry.name)
      const stat = await fs.promises.lstat(absolute)
      if (entries.length >= MAX_ENTRIES) throw new JotError('INVALID_INPUT', '目录超过 1000 个文件或文件夹')
      if (stat.isDirectory()) {
        entries.push({ path: rel, data: null })
        await walk(absolute, rel + '/')
      } else if (stat.isFile()) {
        if (bytes + stat.size > MAX_PACKAGE_BYTES) throw new JotError('INVALID_INPUT', '目录超过 32 MiB')
        const data = await fs.promises.readFile(absolute)
        bytes += data.byteLength
        if (bytes > MAX_PACKAGE_BYTES) throw new JotError('INVALID_INPUT', '目录超过 32 MiB')
        entries.push({ path: rel, data })
      } else if (issues) issues[rel] = '资源不能使用链接或特殊文件：' + rel
      else throw new JotError('INVALID_INPUT', '目录只能包含普通文件和文件夹：' + rel)
    }
  }
  await walk(source, '')
  return entries
}

async function packagePath(root: string, relative: string): Promise<string> {
  const parts = packageSegments(relative)
  let current = root
  await directory(current)
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part)
    await directory(current)
  }
  return path.join(current, parts.at(-1)!)
}

export async function readPackageText(root: string, relative: string): Promise<string> {
  const file = await packagePath(root, relative)
  const stat = await fs.promises.lstat(file)
  if (!stat.isFile()) throw new JotError('INVALID_INPUT', '包内资源必须是普通文件')
  if (stat.size > MAX_SKILL_TEXT_BYTES) throw new JotError('INVALID_INPUT', '包内文本超过 256 KiB')
  return skillText(await fs.promises.readFile(file))
}

export function packageText(entries: PackageEntry[], name: string): string | null {
  const data = entries.find(entry => entry.path === name)?.data
  return data ? skillText(data) : null
}

/** 技能和插件使用同一种目录读取与暂存安装机制。 */
export class PackageFiles {
  constructor(
    private readonly getRoot: () => string,
    private readonly entryFile: PackageEntryFile = 'SKILL.md',
    private readonly validName: (name: string) => boolean = isSkillName,
  ) {}

  private async folder(name: string, createRoot = false): Promise<string> {
    if (!this.validName(name)) throw new JotError('INVALID_INPUT', '包目录名无效')
    const root = this.getRoot()
    await directory(path.dirname(root))
    if (createRoot) await fs.promises.mkdir(root, { recursive: true })
    await directory(root)
    return path.join(root, name)
  }

  async directories(): Promise<string[]> {
    const root = this.getRoot()
    if (!(await statOrMissing(root))) return []
    await directory(path.dirname(root))
    await directory(root)
    const entries = await fs.promises.readdir(root, { withFileTypes: true })
    return entries.filter(entry => !entry.name.startsWith('.jot-package-') && (entry.isDirectory() || entry.isSymbolicLink())).map(entry => entry.name).sort((a, b) => a.localeCompare(b))
  }

  async directoryNames(): Promise<string[]> {
    const root = this.getRoot()
    if (!(await statOrMissing(root))) return []
    await directory(path.dirname(root))
    await directory(root)
    return fs.promises.readdir(root)
  }

  async hasScripts(name: string, relative = 'scripts'): Promise<boolean> {
    return (await statOrMissing(await packagePath(await this.folder(name), relative)))?.isDirectory() ?? false
  }

  async read(name: string, rel: string = this.entryFile): Promise<string> {
    return readPackageText(await this.folder(name), rel)
  }

  async readIfExists(name: string, rel: string = this.entryFile): Promise<string | null> {
    try { return await this.read(name, rel) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async write(name: string, text: string): Promise<void> {
    skillText(Buffer.from(text, 'utf8'))
    const target = await this.folder(name)
    await directory(target)
    const file = path.join(target, this.entryFile)
    if (!(await fs.promises.lstat(file)).isFile()) throw new JotError('INVALID_INPUT', this.entryFile + ' 必须是普通文件')
    await writeFileAtomic(file, text)
  }

  async remove(name: string, commit?: () => Promise<void>): Promise<void> {
    const target = await this.folder(name)
    const info = await fs.promises.lstat(target)
    if (!info.isDirectory() && !info.isSymbolicLink() && !info.isFile()) throw new JotError('INVALID_INPUT', '包路径不是普通文件、文件夹或链接')
    const stage = await fs.promises.mkdtemp(path.join(path.dirname(target), '.jot-package-'))
    const previous = path.join(stage, name)
    let displaced = false
    let committed = false
    try {
      await fs.promises.rename(target, previous)
      displaced = true
      try { await commit?.(); committed = true }
      catch (error) { await fs.promises.rename(previous, target); displaced = false; throw error }
    } finally {
      if (!displaced || committed) await fs.promises.rm(stage, { recursive: true, force: true }).catch(error =>
        console.warn('[packages] 无法清理临时目录：', (error as Error).message))
    }
  }

  async snapshot(name: string, skill?: string): Promise<PackageSnapshot> {
    const root = await this.folder(name)
    if (skill && !isSkillName(skill)) throw new JotError('INVALID_INPUT', '技能标识无效')
    await directory(root)
    if (skill) await directory(path.join(root, 'skills'))
    const issues: Record<string, string> = {}
    const entries = await readPackage(skill ? path.join(root, 'skills', skill) : root, skill ? 'SKILL.md' : this.entryFile, issues)
    return { entries, issues }
  }

  async package(name: string): Promise<PackageEntry[]> {
    return readPackage(await this.folder(name), this.entryFile)
  }

  async skillPackage(name: string, skillName: string): Promise<PackageEntry[]> {
    if (!isSkillName(skillName)) throw new JotError('INVALID_INPUT', '技能标识无效')
    const root = await this.folder(name)
    await directory(root)
    await directory(path.join(root, 'skills'))
    return readPackage(path.join(root, 'skills', skillName), 'SKILL.md')
  }

  /** 新目录先完整暂存，再替换；失败恢复原目录，不混装旧资源。 */
  async replace(name: string, entries: PackageEntry[], commit?: () => Promise<void>): Promise<void> {
    validatePackageEntries(entries, this.entryFile)
    const target = await this.folder(name)
    await directory(target)
    const stage = await fs.promises.mkdtemp(path.join(path.dirname(target), '.jot-package-'))
    const next = path.join(stage, 'next'), previous = path.join(stage, 'previous')
    let displaced = false
    let published = false
    let committed = false
    try {
      await fs.promises.mkdir(next)
      await materialize(next, entries)
      await fs.promises.rename(target, previous)
      displaced = true
      try {
        await fs.promises.rename(next, target)
        published = true
        await commit?.()
        committed = true
      } catch (error) {
        if (published) await fs.promises.rename(target, next)
        await fs.promises.rename(previous, target)
        displaced = false
        throw error
      }
    } finally {
      // 替换成功清理旧包；恢复失败时保留暂存供人工处理。
      if (!displaced || committed) await fs.promises.rm(stage, { recursive: true, force: true }).catch(error =>
        console.warn('[packages] 无法清理暂存目录：', (error as Error).message))
    }
  }

  async install(name: string, entries: PackageEntry[], commit?: () => Promise<void>): Promise<void> {
    validatePackageEntries(entries, this.entryFile)
    const target = await this.folder(name, true)
    if (await statOrMissing(target)) throw new JotError('CONFLICT', '目录已存在，请检查标识')
    const stage = await fs.promises.mkdtemp(path.join(path.dirname(target), '.jot-package-'))
    try {
      await materialize(stage, entries)
      if (await statOrMissing(target)) throw new JotError('CONFLICT', '目录已存在，请检查标识')
      await fs.promises.rename(stage, target)
      try { await commit?.() }
      catch (error) { await fs.promises.rename(target, stage); throw error }
    } finally {
      await fs.promises.rm(stage, { recursive: true, force: true }).catch(error =>
        console.warn('[packages] 无法清理临时目录：', (error as Error).message))
    }
  }
}

/** 只接受包内确定路径，保留二进制资产，声明入口必须存在。 */
export function validatePackageEntries(entries: PackageEntry[], entryFile: string): void {
  if (entries.length > MAX_ENTRIES) throw new JotError('INVALID_INPUT', '包超过1000个条目')
  const names = new Map<string, boolean>()
  let bytes = 0
  for (const entry of entries) {
    const parts = packageSegments(entry.path), key = entry.path.toLowerCase()
    if (names.has(key)) throw new JotError('INVALID_INPUT', '包内路径重复：' + entry.path)
    names.set(key, entry.data === null)
    bytes += entry.data?.byteLength ?? 0
    if (bytes > MAX_PACKAGE_BYTES) throw new JotError('INVALID_INPUT', '包超过32MiB')
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/').toLowerCase()
      if (names.get(parent) === false) throw new JotError('INVALID_INPUT', '包内文件不能作为目录：' + parent)
    }
  }
  for (const [name, directory] of names) if (!directory && [...names.keys()].some(other => other.startsWith(name + '/'))) {
    throw new JotError('INVALID_INPUT', '包内文件不能作为目录：' + name)
  }
  if (!entries.some(entry => entry.path === entryFile && entry.data !== null)) throw new JotError('INVALID_INPUT', '包缺少' + entryFile)
}

async function materialize(root: string, entries: PackageEntry[]): Promise<void> {
  for (const entry of entries) {
    const file = path.join(root, ...packageSegments(entry.path))
    if (entry.data === null) await fs.promises.mkdir(file, { recursive: true })
    else {
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await fs.promises.writeFile(file, entry.data, { flag: 'wx' })
    }
  }
}
