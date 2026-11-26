import fs from 'node:fs'
import path from 'node:path'
import type { AppExtensionManifest } from '@shared/app-extensions'
import { createWorkReportOptions, type WorkReportOptions } from '../../shared/work-reports'

export function appExtensionSource(parent: string, id: string, patch: Partial<AppExtensionManifest> = {}) {
  const root = path.join(parent, id)
  const manifest: AppExtensionManifest = {
    schemaVersion: 1, apiVersion: 1, id, name: '虚构日记插件', version: '1.0.0', minAppVersion: '0.1.0', description: '隔离测试中使用的声明式应用插件',
    commands: [{ id: 'today', name: '写今日记录', icon: 'book-open', action: 'daily-note', defaults: {
      directory: null, filename: '{{yyyy}}-{{MM}}-{{dd}}.md', template: { kind: 'package', path: 'templates/default.md' },
    } }], ...patch,
  }
  const write = (relative: string, value: string | Buffer) => {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, value)
  }
  write('extension.json', JSON.stringify(manifest, null, 2))
  write('templates/default.md', '# 虚构日记模板\n\n今天的记录：\n')
  return { root, manifest, write }
}

export const workDiaryOptions = (root: string, options: Partial<WorkReportOptions> = {}): WorkReportOptions => ({
  ...createWorkReportOptions(), root, template: { kind: 'package', path: 'templates/default.md' }, ...options,
})
