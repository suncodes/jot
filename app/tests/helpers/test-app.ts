import fs from 'node:fs'
import path from 'node:path'
import type { Args, Channel, Ret } from '@shared/ipc'
import { Core, type CoreOptions } from '../../electron/core'
import { createHandlers, type Platform } from '../../electron/ipc/handlers'
import { dispatch } from '../../electron/ipc/register'
import { makeTmpDir } from './tmp'
import { startFakeLlm } from './fake-llm'

/** 仅使用隔离虚构库和本地假模型。 */
export async function testApp(emit: CoreOptions['emit'] = () => {}) {
  const tmp = makeTmpDir('file-first-pipelines')
  const fake = await startFakeLlm(req => JSON.stringify(String(req.messages[0]?.content).includes('任务技能：jot-core:content-organize')
    ? { directoryPath: 'content/工作', tags: ['需求'], people: [], confidence: 0.95, reason: '测试建议' }
    : String(req.messages[0]?.content).includes('任务技能：jot-core:daily-review')
      ? { oneLine: '你记录了今天的想法', done: ['完成了记录中明确说明的事项'], highlights: [], followUps: [] }
      : String(req.messages[0]?.content).includes('任务技能：jot-core:term-organize') ? { groups: [] }
      : { oneLine: '一份资料', points: ['材料中的明确事实'], entities: null }))
  let now = new Date('2026-11-19T12:00:00+08:00')
  const root = path.join(tmp.dir, 'vault')
  const appExtensionCandidates = path.join(tmp.dir, 'app-extension-candidates')
  const makeCore = () => new Core({ now: () => now, userDataDir: path.join(tmp.dir, 'user'), secrets: { encrypt: s => s, decrypt: s => s },
    bundledAppExtensionRoot: appExtensionCandidates,
    devModel: { baseUrl: fake.baseUrl, apiKey: 'fake', model: 'fake' }, emit })
  let core = makeCore()
  await core.settings.load()
  await core.settings.set({ classify: { enabled: false }, daily: { enabled: false } })
  await core.openVault(root, true)
  await core.jobs.stop()
  const platform: Platform = {
    appInfo: () => ({ version: 'test', dev: true, platform: 'test' }), pickFiles: async () => null, pickDirectory: async () => null,
    saveFile: async () => null, hideCapture: () => {}, resizeCapture: () => {}, openExternal: async () => {},
    async trashItem(absolute) {
      const recycle = path.join(tmp.dir, 'system-trash', path.basename(absolute))
      fs.mkdirSync(path.dirname(recycle), { recursive: true })
      await fs.promises.rename(absolute, recycle)
    },
  }
  let handlers = createHandlers(core, platform)
  return {
    get core() { return core }, fake, tmp, root, appExtensionCandidates, platform,
    clock: (value: string) => { now = new Date(value) },
    file: (rel: string) => path.join(root, rel),
    write: (rel: string, text: string | Buffer) => { const absolute = path.join(root, rel); fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, text) },
    async call<K extends Channel>(channel: K, args: Args<K>): Promise<Ret<K>> {
      const r = await dispatch(handlers, channel, args)
      if (!r.ok) throw new Error(r.error.code + ': ' + r.error.message)
      return r.data
    },
    async reopen({ removeIndex = false } = {}) {
      await core.dispose()
      if (removeIndex) for (const name of ['index.db', 'index.db-wal', 'index.db-shm']) {
        const file = path.join(root, '.jot', name)
        if (fs.existsSync(file)) fs.unlinkSync(file)
      }
      core = makeCore()
      await core.init()
      await core.quiesce()
      await core.jobs.stop()
      handlers = createHandlers(core, platform)
    },
    async close() { await core.dispose(); await fake.close(); tmp.cleanup() },
  }
}
export function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
