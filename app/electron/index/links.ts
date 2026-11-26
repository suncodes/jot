import fs from 'node:fs'
import { JotError } from '@shared/result'
import type { FileLink, PathChange } from '@shared/files'
import type { DocMeta } from '@shared/types'
import type { IndexService } from './index'
import type { VaultService } from '../vault/vault'
import { isMarkdown, wikilinkTarget } from '../vault/doc'
import { intendedTarget, mappedPath, resolveTarget, rewriteLinks } from '../vault/links'

/** 链接由当前文件解析；不保存 ID、指纹或不可重建的永久目标绑定。 */
export class LinkService {
  constructor(private readonly index: IndexService, private readonly vault: VaultService) {}

  async resolve(from: string, target: string, kind: 'markdown' | 'wiki' = 'wiki'): Promise<DocMeta> {
    this.vault.abs(from)
    const paths = (await this.vault.listFiles()).map(file => file.path)
    const result = resolveTarget(from, target, kind, paths)
    if (result.ambiguous) throw new JotError('CONFLICT', '有多个同名文件，请使用完整路径', { candidates: result.ambiguous })
    if (!result.path) throw new JotError('NOT_FOUND', '没有找到当前链接目标：' + target)
    return this.vault.read({ path: result.path })
  }

  async list(rel: string, direction: 'incoming' | 'outgoing' = 'outgoing'): Promise<FileLink[]> {
    this.vault.abs(rel)
    const paths = (await this.vault.listFiles()).map(file => file.path)
    const directories = await this.vault.directories('content', true)
    const targets = [...paths, 'content', ...directories.map(directory => directory.path)]
    return this.index.linkEntries().map(entry => {
      const result = resolveTarget(entry.src, entry.dst, entry.kind, targets)
      return { from: entry.src, target: entry.dst, kind: entry.kind, path: result.path ?? intendedTarget(entry.src, entry.dst, entry.kind), missing: !result.path, ambiguous: result.ambiguous }
    }).filter(link => direction === 'outgoing' ? link.from === rel : link.path === rel || link.missing && link.target === rel)
  }

  /** 已知改名／移动后维护可确定的链接，逐文件反馈失败，不回滚已经移动的用户文件。 */
  async maintain(changes: PathChange[]): Promise<{ path: string; message: string }[]> {
    if (!changes.some(change => change.from !== change.to)) return []
    const files = await this.vault.listFiles()
    const reversed = changes.map(change => ({ from: change.to, to: change.from }))
    const oldPaths = files.map(file => mappedPath(file.path, reversed))
    const failed: { path: string; message: string }[] = []
    for (const file of files) {
      try {
        const moved = mappedPath(file.path, reversed) !== file.path
        const effective = moved ? changes : changes.filter(change => !fs.existsSync(this.vault.abs(change.from)))
        const properties = await this.vault.metadata.read(file.path)
        const data = properties.data
        const patch: Record<string, unknown> = {}
        if (!properties.attachment && data.type === 'source-summary' && typeof data.source === 'string') {
          const source = wikilinkTarget(data.source)!
          const target = mappedPath(source, effective)
          if (target !== source) patch.source = target
        }
        if (Object.keys(patch).length) await this.vault.patchFrontmatter({ path: file.path }, patch, 'user')
        if (!isMarkdown(file.path) || properties.attachment) continue
        const doc = await this.vault.read({ path: file.path })
        const from = mappedPath(file.path, reversed)
        const next = rewriteLinks(doc.body, from, file.path, effective, oldPaths)
        if (next !== doc.body) await this.vault.saveBody({ path: file.path }, next, doc.hash)
      } catch (error) {
        failed.push({ path: file.path, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return failed
  }
}
