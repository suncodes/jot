import type { AppExtensionManifest } from '@shared/app-extensions'
import { extensionTemplates } from '@shared/app-extensions'
import { JotError } from '@shared/result'
import { packageText, validatePackageEntries, type PackageEntry } from '../vault/package-files'
import { appExtensionManifest } from './schema'
import { compareVersions } from './versions'
import { validateNoteTemplate } from './templates'

export function parseAppExtension(text: string): AppExtensionManifest {
  let raw: unknown
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')) }
  catch { throw new JotError('INVALID_INPUT', 'extension.json 必须是有效的 JSON') }
  const parsed = appExtensionManifest.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    throw new JotError('INVALID_INPUT', 'extension.json ' + (issue.path.join('.') || '清单') + '：' + issue.message)
  }
  return parsed.data
}

export function inspectAppExtension(entries: PackageEntry[], appVersion: string): { manifest: AppExtensionManifest; issues: string[] } {
  validatePackageEntries(entries, 'extension.json')
  const text = packageText(entries, 'extension.json')
  if (text === null) throw new JotError('INVALID_INPUT', '应用插件缺少 extension.json')
  const manifest = parseAppExtension(text)
  const issues: string[] = []
  if (compareVersions(appVersion, manifest.minAppVersion) < 0) issues.push('需要 Jot ' + manifest.minAppVersion + ' 或更高版本，当前为 ' + appVersion)
  for (const template of manifest.commands.flatMap(command => extensionTemplates(command.defaults))) if (template.kind === 'package') {
    const relative = template.path
    try {
      const template = packageText(entries, relative)
      if (template === null) issues.push('缺少声明的模板：' + relative)
      else validateNoteTemplate(template)
    } catch (error) { issues.push(relative + '：' + (error as Error).message) }
  }
  return { manifest, issues }
}
