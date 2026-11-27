import type { OperationPlatform } from '../operations/service'
import { JotError } from '@shared/result'
import type { AppInfo, FolderChange } from '@shared/types'
import type { Core } from '../core'
import { normalizeRel } from '../vault/paths'
import { resolveFile } from '../agent/file-paths'
import type { Handlers } from './register'

/** 需要 Electron 才能做的事，由主进程入口提供；测试里用假实现 */
export interface Platform extends OperationPlatform {
  appInfo(): AppInfo
  pickDirectory(purpose?: 'skill' | 'plugin' | 'extension'): Promise<string | null>
  hideCapture(): void
  resizeCapture(height: number): void
  openExternal(absPath: string): Promise<void>
}

export function createHandlers(core: Core, platform: Platform): Handlers {
  core.operations.setPlatform(platform)
  const { vault, index, model, jobs, state, files, agent } = core
  const { skillImporter, pluginImporter } = core.capabilities
  core.extensions.setPlatform({ pickDirectory: async () => platform.pickDirectory('extension') })

  let openingVault = false
  core.capabilities.setPlatform(platform, () => openingVault)
  let vaultGeneration = 0
  const inCurrentVault = <T>(operation: () => Promise<T>, generation = vaultGeneration): Promise<T> =>
    core.mutate(() => {
      if (openingVault || generation !== vaultGeneration) throw new JotError('CONFLICT', '库已切换，请在当前库重试')
      return operation()
    })
  const directoryPath = (dir?: string): string => dir ?? 'content'
  const summariesFor = (source: { path: string }): string[] => files.summaries(source.path)
  const liveSummary = (doc: { sourcePath?: string }): boolean => !!doc.sourcePath
  const moveRecords = (paths: FolderChange['paths']): Promise<void> => core.moved(paths)
  const assertOrdinary = (doc: { type: string; path: string }): void => {
    if (files.isSource(doc.path)) return
    if (doc.type === 'daily') throw new JotError('INVALID_INPUT', '日总结按日期维护，可编辑或重新生成，不改名、移动或删除')
    if (doc.type === 'source-summary') throw new JotError('INVALID_INPUT', '摘要由文件条目统一管理，请在文件详情中操作')
  }
  return {
    ...core.operations.handlers,
    'library:pins': () => inCurrentVault(() => core.pins.list()),
    'library:setPinned': input => inCurrentVault(() => core.pins.set(input)),
    'library:reorderPin': ({ path, direction }) => inCurrentVault(() => core.pins.reorder(path, direction)),
    'commands:list': input => core.commands.list(input),
    'commands:execute': ({ id }) => core.commands.execute(id),
    'extensions:configuration': () => core.extensionState.getConfiguration(),
    'extensions:catalog': () => core.extensions.catalog(),
    'extensions:previewImport': input => core.extensions.previewImport(input),
    'extensions:confirmImport': ({ token, installAiPlugin }) => core.extensions.confirmImport(token, installAiPlugin),
    'extensions:cancelImport': ({ token }) => { core.extensions.cancelImport(token) },
    'extensions:previewAiPlugin': ({ id }) => core.extensions.previewAiPlugin(id),
    'extensions:confirmAiPlugin': ({ token }) => core.extensions.confirmAiPlugin(token),
    'extensions:cancelAiPlugin': ({ token }) => { core.extensions.cancelAiPlugin(token) },
    'extensions:setEnabled': ({ id, enabled }) => core.extensions.setEnabled(id, enabled),
    'extensions:saveProfile': ({ id, profile, shortcut }) => core.extensions.saveProfile(id, profile, shortcut),
    'extensions:removeProfile': ({ id, profileId }) => core.extensions.removeProfile(id, profileId),
    'extensions:uninstall': ({ id }) => core.extensions.uninstall(id),
    'extensions:readTemplate': ({ id, template }) => core.extensions.readTemplate(id, template),
    'extensions:copyTemplate': ({ id, path, targetPath }) => core.extensions.copyTemplate(id, path, targetPath),
    'extensions:previewDateNote': input => core.commands.preview(input),
    'extensions:previewWorkReport': input => core.commands.previewWorkReport(input),
    'shortcuts:get': () => core.extensionState.getShortcuts(),
    'shortcuts:set': input => core.commands.saveShortcuts(input),
    'settings:modelBudget': input => core.pi.resolveLimits(input),
    'settings:reasoning': input => core.pi.reasoningOptions(input),
    'settings:testModel': ({ modelId, channelId, contextWindow, ...override }) => {
      const saved = modelId ? core.settings.getModelConfig(modelId) : null
      const apiKey = channelId ? core.settings.channelKey(channelId) : saved?.apiKey
      return model.test(core.pi, core.vault.isOpen ? core.vault.path : '.', { ...override, ...(contextWindow !== undefined ? { contextWindow: contextWindow ?? undefined } : {}), apiKey: override.apiKey ?? apiKey }, saved)
    },
    'doc:properties': ({ path }) => vault.getProperties(path),
    'links:list': ({ path, direction }) => core.links.list(path, direction),

    'app:info': () => platform.appInfo(),
    'app:status': () => ({
      inboxCount: index.isOpen ? index.inboxCount() : 0,
      jobs: state.isOpen ? jobs.summary() : { running: 0, queued: 0, failed: 0, waitingModel: 0 },
      modelState: model.status(),
    }),

    'vault:status': () => vault.status(),
    'vault:pick': async () => {
      const picked = await platform.pickDirectory()
      return picked ? { path: picked } : null
    },
    'vault:open': async ({ path, create }) => {
      if (openingVault) throw new JotError('CONFLICT', '正在打开库，请稍后重试')
      openingVault = true
      vaultGeneration++
      skillImporter.clear()
      pluginImporter.clear()
      try { return await core.openVault(path, create) }
      finally { skillImporter.clear(); pluginImporter.clear(); openingVault = false }
    },
    'vault:tree': ({ dir }) => vault.tree(dir),
    'folder:move': async ({ path, toDir, name }) => {
      await core.idle()
      const moved = await core.mutate(async () => {
        const from = path
        const result = await vault.moveFolder(from, directoryPath(toDir), name)
        await moveRecords(result.paths)
        return result
      })
      await core.idle()
      return moved
    },
    'folder:delete': async ({ path }) => {
      await core.idle()
      const result = await core.mutate(async () => {
        const from = path
        const summaries = index.allPaths().filter(p => { const doc = index.getDoc(p)!; return liveSummary(doc) && doc.sourcePath!.startsWith(normalizeRel(from) + '/') })
        const result = await vault.trashFolder(from, summaries)
        jobs.cancelTargets([from])
        return result
      })
      await core.idle()
      return result
    },
    'capture:hideWindow': () => platform.hideCapture(),
    'capture:resize': ({ height }) => platform.resizeCapture(height),

    'doc:get': async ({ ref }) => core.decorate(await vault.read(ref)),
    'doc:saveBody': ({ ref, body, baseHash }) => core.mutate(() => vault.saveBody(ref, body, baseHash, 'user')),
    'doc:rename': async ({ ref, newName }) => {
      await core.idle()
      const meta = await core.mutate(async () => {
        const doc = await vault.read(ref)
        assertOrdinary(doc)
        const renamed = await vault.rename(ref, newName)
        await moveRecords([{ from: doc.path, to: renamed.path }])
        return renamed
      })
      await core.idle()
      return vault.read({ path: meta.path })
    },
    'doc:move': async ({ ref, toDir }) => {
      await core.idle()
      const moved = await core.mutate(async () => {
        const doc = await vault.read(ref)
        assertOrdinary(doc)
        const target = directoryPath(toDir)
        if (!/^(content|inbox|ideas)(\/|$)/.test(normalizeRel(target))) throw new JotError('INVALID_INPUT', '请选择 content/、inbox/ 或 ideas/ 下的目录')
        const meta = await vault.move(ref, target)
        await moveRecords([{ from: doc.path, to: meta.path }])
        return meta
      })
      await core.idle()
      return vault.read({ path: moved.path })
    },
    'doc:delete': async ({ ref }) => {
      const doc = await vault.read(ref)
      assertOrdinary(doc)
      if (files.isSource(doc.path)) {
        await core.idle()
        const summaries = summariesFor(doc)
        const result = await core.mutate(async () => {
          const result = await vault.trashMany([doc.path, ...summaries])
          jobs.cancelTargets([doc.path, ...summaries])
          return result
        })
        await core.idle()
        return result
      }
      return core.mutate(async () => {
        const result = await vault.trash(ref)
        jobs.cancelTargets([doc.path])
        return result
      })
    },
    'library:delete': async ({ path, scope }) => {
      await core.idle()
      const removed = await core.mutate(async () => {
        const item = core.content.library({ path, limit: 1 }).items[0]
        if (!item) throw new JotError('NOT_FOUND', '内容不存在')
        const all = summariesFor(item)
        const paths = item.kind === 'file' && scope === 'entry'
          ? [...(!item.sourceMissing ? [item.path] : []), ...(item.summaryPath ? [item.summaryPath] : []), ...all] : [item.path]
        const result = await vault.trashMany([...new Set(paths)])
        jobs.cancelTargets(paths)
        return result
      })
      await core.idle()
      return removed
    },
    'doc:openExternal': ({ path }) => platform.openExternal(resolveFile(vault, path).absolute),
    'doc:quickOpen': async ({ query, limit }) => {
      await core.idle()
      return index.quickOpen(query, limit)
    },

    'doc:resolveLink': async ({ from, target, kind }) => {
      await core.idle()
      return core.links.resolve(from, target, kind)
    },

    'content:directories': async ({ parentPath, recursive }) => {
      await core.idle()
      return core.content.directories(parentPath, recursive)
    },
    'content:stats': async ({ groupBy, filter, scope }) => {
      await core.idle()
      return core.content.stats(groupBy, { ...filter, ...(scope ? { scope } : {}) })
    },
    'library:facets': async ({ scope }) => {
      await core.idle()
      return core.content.facets(scope)
    },
    'library:query': async (q) => {
      await core.idle()
      return index.library(q)
    },
    'library:resolve': async ({ path }) => {
      await core.idle()
      if (!path) return null
      const item = index.library({ path, limit: 1 }).items[0]
      if (item) return item
      const source = index.getDoc(path)?.sourcePath
      return source ? index.library({ path: source, limit: 1 }).items[0] ?? null : null
    },
    'search:query': async (q) => {
      await core.idle()
      const r = index.search(q)
      return { total: r.total, items: r.items.map((h) => ({ ...h, doc: core.decorate(h.doc) })) }
    },

    'capabilities:setPluginEnabled': ({ id, enabled }) => core.capabilities.togglePlugin(id, enabled),
    'capabilities:changeAgent': change => core.capabilities.agent(change),
    'capabilities:changeSkill': change => core.capabilities.skill(change),
    'capabilities:changePlugin': change => core.capabilities.plugin(change),
    'capabilities:resources': ({ owner, id }) => core.capabilities.resources(owner, id),
    'capabilities:readResource': ({ owner, id, path }) => core.capabilities.readResource(owner, id, path),
    'capabilities:patchResources': ({ owner, id, files }) => core.capabilities.patchResources(owner, id, files),
    'capabilities:setToolEnabled': ({ id, enabled }) => core.capabilities.tool(id, enabled),
    'capabilities:setAgentEnabled': ({ id, enabled }) => core.capabilities.enableAgent(id, enabled),
    'capabilities:setTaskSkills': patch => core.capabilities.tasks(patch),
    'capabilities:impact': ({ owner, id }) => core.capabilities.impact(owner, id),
    'capabilities:previewUpdate': ({ owner, id }) => core.capabilities.importPreview(owner, id),
    'capabilities:previewSkillImport': () => core.capabilities.importPreview('skill') as Promise<import('@shared/capabilities').SkillImportPreview | null>,
    'capabilities:previewPluginImport': () => core.capabilities.importPreview('plugin') as Promise<import('@shared/capabilities').PluginImportPreview | null>,
    'capabilities:confirmSkillImport': ({ token, name }) => core.capabilities.importConfirm('skill', token, name),
    'capabilities:confirmPluginImport': ({ token }) => core.capabilities.importConfirm('plugin', token),
    'capabilities:cancelSkillImport': ({ token }) => core.capabilities.importCancel('skill', token),
    'capabilities:cancelPluginImport': ({ token }) => core.capabilities.importCancel('plugin', token),
    'capabilities:runs': (page) => agent.records(page),
    'capabilities:removeRun': ({ runId }) => agent.removeRecord(runId),
    'capabilities:catalog': () => inCurrentVault(() => core.capabilities.catalog()),
    'agent:create': () => agent.create(),
    'agent:send': ({ conversationId, text, context, retryMessageId }) => {
      if (openingVault) throw new JotError('CONFLICT', '正在打开库，请稍后重试')
      return agent.send(conversationId, text, context, retryMessageId)
    },
    'agent:setModel': ({ conversationId, modelId }) => inCurrentVault(async () => agent.setModel(conversationId, modelId)),
    'agent:setReasoning': ({ conversationId, effort }) => inCurrentVault(async () => agent.setReasoning(conversationId, effort)),
    'agent:confirm': ({ runId, requestId, approved }) => agent.confirm(runId, requestId, approved),
    'agent:abort': ({ runId }) => agent.abort(runId),
  }
}
