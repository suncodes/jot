import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AppExtensionCatalog, ShortcutConfiguration } from '@shared/app-extensions'
import { createShortcutConfiguration } from '@shared/app-extensions'
import type { AppCommand } from '@shared/commands'
import { extensionCommandId } from '@shared/commands'
import { call, on } from '@/api'
import { useAppStore } from './app'
import { t } from '@/strings'

export const useExtensionsStore = defineStore('extensions', () => {
  const catalog = ref<AppExtensionCatalog>({ installed: [], candidates: [], issues: [] })
  const commands = ref<AppCommand[]>([])
  const shortcuts = ref<ShortcutConfiguration>(createShortcutConfiguration())
  const error = ref('')
  const loading = ref(false)
  const busy = ref(false)
  let sequence = 0
  let commandSequence = 0

  const availableCommands = computed(() => commands.value.filter(command => command.availability.available))
  const pinnedCommands = computed(() => shortcuts.value.pinned.map(id => availableCommands.value.find(command => command.id === id)).filter((command): command is AppCommand => !!command))
  const allCommands = computed(() => {
    const entries = new Map(commands.value.map(command => [command.id, command]))
    for (const pkg of catalog.value.installed) {
      for (const profile of pkg.profiles) {
        const id = extensionCommandId(pkg.id, profile.id, profile.commandId)
        if (!entries.has(id)) entries.set(id, {
          id, name: profile.name, icon: pkg.manifest?.commands.find(command => command.id === profile.commandId)?.icon ?? 'notebook-pen',
          source: { kind: 'extension', extensionId: pkg.id, profileId: profile.id },
          availability: pkg.enabled ? profile.availability : { available: false, reason: t.extensions.disabled },
        })
      }
    }
    for (const id of [...shortcuts.value.pinned, ...shortcuts.value.bindings.map(binding => binding.commandId)]) {
      if (!entries.has(id)) entries.set(id, { id, name: id, icon: 'notebook-pen', source: { kind: 'core' }, availability: { available: false, reason: t.shortcuts.unavailable } })
    }
    return [...entries.values()]
  })

  async function refreshCommands(): Promise<void> {
    const current = ++commandSequence
    const root = useAppStore().vault.path
    const [nextCommands, nextShortcuts] = await Promise.all([call('commands:list', { availableOnly: false }), call('shortcuts:get')])
    if (current !== commandSequence || root !== useAppStore().vault.path) return
    commands.value = nextCommands
    shortcuts.value = nextShortcuts
  }
  async function refresh(): Promise<void> {
    const current = ++sequence
    const root = useAppStore().vault.path
    loading.value = true
    try {
      const next = await call('extensions:catalog')
      if (current !== sequence || root !== useAppStore().vault.path) return
      catalog.value = next
      await refreshCommands()
      error.value = ''
    } catch (e) { if (current === sequence) error.value = (e as Error).message }
    finally { if (current === sequence) loading.value = false }
  }
  function reset(): void {
    sequence++; commandSequence++
    catalog.value = { installed: [], candidates: [], issues: [] }
    commands.value = []; shortcuts.value = createShortcutConfiguration(); error.value = ''; loading.value = false
  }
  function connect(): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined
    let reloadTimer: ReturnType<typeof setTimeout> | undefined
    const reload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => void refresh(), 100) }
    const offs = [
      on('extensions:changed', () => { void refresh() }),
      on('capabilities:changed', reload),
      on('vault:changed', reload),
      // 目录刷新会重注册命令，此处只刷新命令，避免再次查询目录形成循环。
      on('commands:changed', () => {
        clearTimeout(timer)
        timer = setTimeout(() => void refreshCommands().catch(e => { error.value = (e as Error).message }), 60)
      }),
    ]
    window.addEventListener('focus', reload)
    return () => { clearTimeout(timer); clearTimeout(reloadTimer); window.removeEventListener('focus', reload); offs.forEach(off => off()); sequence++; commandSequence++ }
  }
  async function saveShortcuts(input: ShortcutConfiguration): Promise<void> {
    const root = useAppStore().vault.path
    const saved = await call('shortcuts:set', input)
    if (root === useAppStore().vault.path) shortcuts.value = saved
  }
  const binding = (id: string) => shortcuts.value.bindings.find(binding => binding.commandId === id)?.hotkey ?? ''
  const displayBinding = (id: string) => binding(id) || (id === 'core.command-palette' ? 'Ctrl+Shift+P' : '')
  const sourceName = (command: AppCommand) => command.source.kind === 'core' ? t.shortcuts.core
    : catalog.value.installed.find(pkg => pkg.id === (command.source.kind === 'extension' ? command.source.extensionId : ''))?.manifest?.name ?? command.source.extensionId

  return { catalog, commands, shortcuts, availableCommands, pinnedCommands, allCommands, error, loading, busy, refresh, reset, connect, saveShortcuts, binding, displayBinding, sourceName }
})
