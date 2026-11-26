import { nextTick, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { AppCommand } from '@shared/commands'
import { call } from '@/api'
import { useAppStore } from './app'
import { useExtensionsStore } from './extensions'
import { useTabsStore } from './tabs'
import { useToastsStore } from './toasts'

export const useCommandsStore = defineStore('commands', () => {
  const app = useAppStore(), extensions = useExtensionsStore(), tabs = useTabsStore(), toasts = useToastsStore()
  const paletteOpen = ref(false), error = ref('')
  const running = ref(new Set<string>())
  const configurationTarget = ref<{ extensionId: string; profileId: string } | null>(null)
  let generation = 0
  watch(() => app.vault.path, () => { generation++; paletteOpen.value = false; configurationTarget.value = null; error.value = '' })

  async function execute(id: string): Promise<boolean> {
    if (running.value.has(id) || extensions.busy) return false
    const current = generation
    running.value.add(id); error.value = ''
    try {
      const result = await call('commands:execute', { id })
      if (current !== generation) return false
      if (result.kind === 'command-palette') {
        paletteOpen.value = true
        void extensions.refresh()
      } else {
        paletteOpen.value = false
        await nextTick()
        if (current !== generation) return false
        if (result.kind === 'open-note') await tabs.open(result.path, { newTab: true, startEditing: result.created })
      }
      return true
    } catch (e) {
      if (current === generation) {
        error.value = (e as Error).message
        toasts.error(error.value)
        void extensions.refresh()
      }
      return false
    } finally { running.value.delete(id) }
  }

  function manage(): void {
    paletteOpen.value = false
    app.settingsSection = 'shortcuts'; app.showSettings = true
  }
  function configure(command: AppCommand): void {
    if (command.source.kind !== 'extension') { manage(); return }
    paletteOpen.value = false
    configurationTarget.value = { extensionId: command.source.extensionId, profileId: command.source.profileId }
    app.settingsSection = 'extensions'; app.showSettings = true
  }
  async function togglePin(id: string): Promise<void> {
    if (extensions.busy) return
    extensions.busy = true
    try {
      const next = shortcutSnapshot()
      next.pinned = next.pinned.includes(id) ? next.pinned.filter(current => current !== id) : [...next.pinned, id]
      await extensions.saveShortcuts(next)
    } catch (e) { toasts.error((e as Error).message) }
    finally { extensions.busy = false }
  }
  async function movePin(id: string, offset: number): Promise<void> {
    if (extensions.busy) return
    extensions.busy = true
    try {
      const next = shortcutSnapshot()
      const visible = extensions.pinnedCommands.map(command => command.id)
      const target = visible[visible.indexOf(id) + offset]
      const from = next.pinned.indexOf(id), to = target ? next.pinned.indexOf(target) : -1
      if (from < 0 || to < 0 || to >= next.pinned.length) return
      ;[next.pinned[from], next.pinned[to]] = [next.pinned[to]!, next.pinned[from]!]
      await extensions.saveShortcuts(next)
    } catch (e) { toasts.error((e as Error).message) }
    finally { extensions.busy = false }
  }
  function shortcutSnapshot() {
    return { ...extensions.shortcuts, pinned: [...extensions.shortcuts.pinned], bindings: extensions.shortcuts.bindings.map(binding => ({ ...binding })) }
  }
  return { paletteOpen, error, running, configurationTarget, execute, manage, configure, togglePin, movePin }
})
