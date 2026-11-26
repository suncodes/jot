import fs from 'node:fs'
import type { ZodType } from 'zod'
import { createAppExtensionConfiguration, createShortcutConfiguration, type AppExtensionConfiguration, type ShortcutConfiguration } from '@shared/app-extensions'
import { JotError } from '@shared/result'
import type { VaultService } from '../vault/vault'
import { writeFileAtomic, writeJson } from '../util/fs'
import { appExtensionConfiguration, shortcutConfiguration } from './schema'

export class AppExtensionState {
  constructor(private readonly vault: VaultService) {}

  private async read<T>(relative: string, schema: ZodType<T>, fallback: () => T): Promise<T> {
    const absolute = this.vault.abs(relative)
    let text: string
    try { text = await fs.promises.readFile(absolute, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback()
      throw new JotError('IO_ERROR', '配置无法读取：' + relative)
    }
    try { return schema.parse(JSON.parse(text)) }
    catch { throw new JotError('INVALID_INPUT', '配置格式无效，请检查后重试：' + relative) }
  }

  getConfiguration(): Promise<AppExtensionConfiguration> {
    return this.read('.jot/app-extensions.json', appExtensionConfiguration, createAppExtensionConfiguration)
  }

  getShortcuts(): Promise<ShortcutConfiguration> {
    return this.read('.jot/shortcuts.json', shortcutConfiguration, createShortcutConfiguration)
  }

  async saveConfiguration(input: AppExtensionConfiguration): Promise<AppExtensionConfiguration> {
    const config = appExtensionConfiguration.parse(input)
    await this.saveChanges({ configuration: config })
    return config
  }

  async saveShortcuts(input: ShortcutConfiguration): Promise<ShortcutConfiguration> {
    const config = shortcutConfiguration.parse(input)
    await this.saveChanges({ shortcuts: config })
    return config
  }

  async saveChanges(input: { configuration?: AppExtensionConfiguration; shortcuts?: ShortcutConfiguration }): Promise<void> {
    const changes: { file: string; value: unknown; previous: string | null }[] = []
    const prepare = async <T>(relative: string, schema: ZodType<T>, value: T) => {
      const file = this.vault.abs(relative)
      const parsed = schema.parse(value)
      const previous = await fs.promises.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (previous !== null) {
        try { schema.parse(JSON.parse(previous)) }
        catch { throw new JotError('INVALID_INPUT', '配置格式无效，请检查后重试：' + relative) }
      }
      changes.push({ file, value: parsed, previous })
    }
    if (input.configuration) await prepare('.jot/app-extensions.json', appExtensionConfiguration, input.configuration)
    if (input.shortcuts) await prepare('.jot/shortcuts.json', shortcutConfiguration, input.shortcuts)
    let written = 0
    try {
      for (const change of changes) { await writeJson(change.file, change.value); written++ }
    } catch (error) {
      for (const change of changes.slice(0, written).reverse()) {
        try {
          if (change.previous === null) await fs.promises.rm(change.file, { force: true })
          else await writeFileAtomic(change.file, change.previous)
        } catch { throw new JotError('IO_ERROR', '配置保存及恢复失败，请检查 .jot/app-extensions.json 和 .jot/shortcuts.json') }
      }
      throw error
    }
  }
}
