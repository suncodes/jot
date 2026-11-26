import type { NoteTemplate } from '@shared/app-extensions'
import { validateResourcePath } from '@shared/date-paths'
import { expandNoteTemplate } from '@shared/note-templates'
import { JotError } from '@shared/result'
import { parseDoc, stringifyDoc } from '../vault/frontmatter'
import { readPackageText } from '../vault/package-files'
import type { VaultService } from '../vault/vault'
import { resolveInVault } from '../vault/paths'

export function validateNoteTemplate(text: string): void {
  const expanded = expandNoteTemplate(text, { date: '2026-11-23', title: '模板预览' })
  if (parseDoc(expanded).invalid) throw new JotError('INVALID_INPUT', '模板的 YAML 属性无效，请先修正')
}

export class NoteTemplateService {
  constructor(private readonly vault: VaultService) {}

  async read(extensionId: string, template: NoteTemplate): Promise<string> {
    if (template.kind === 'none') return ''
    validateResourcePath(template.path)
    try {
      return template.kind === 'package'
        ? await this.vault.appExtensionFiles.read(extensionId, template.path)
        : await readPackageText(this.vault.abs('templates'), template.path.slice('templates/'.length))
    } catch (error) {
      if (error instanceof JotError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new JotError('NOT_FOUND', '模板不存在：' + template.path)
      throw new JotError('IO_ERROR', '模板读取失败：' + template.path)
    }
  }

  async render(extensionId: string, template: NoteTemplate, input: { date: string; title: string; created: string }): Promise<string> {
    const text = await this.read(extensionId, template)
    const parsed = parseDoc(expandNoteTemplate(text, input))
    if (parsed.invalid) throw new JotError('INVALID_INPUT', '模板的 YAML 属性无效，请先修正')
    return stringifyDoc({ ...parsed.data, type: 'note', created: input.created }, parsed.body)
  }

  async copy(extensionId: string, sourcePath: string, targetPath: string): Promise<{ path: string }> {
    validateResourcePath(targetPath)
    resolveInVault(this.vault.abs('templates'), targetPath.slice('templates/'.length))
    const text = await this.read(extensionId, { kind: 'package', path: sourcePath })
    await this.vault.createText(targetPath, text)
    return { path: targetPath }
  }
}
