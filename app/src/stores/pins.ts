import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { LibraryPin } from '@shared/files'
import { call, on } from '@/api'
import { useAppStore } from './app'
import { useToastsStore } from './toasts'

export const useLibraryPinsStore = defineStore('library-pins', () => {
  const items = ref<LibraryPin[]>([])
  let sequence = 0
  const isPinned = (path: string) => items.value.some(pin => pin.path.toLocaleLowerCase() === path.toLocaleLowerCase())
  async function refresh(): Promise<void> {
    const request = ++sequence
    if (!useAppStore().vault.open) { items.value = []; return }
    const result = await call('library:pins')
    if (request === sequence) items.value = result
  }
  async function set(path: string, kind: LibraryPin['kind'], pinned: boolean): Promise<void> {
    const request = ++sequence
    const result = await call('library:setPinned', { path, kind, pinned })
    if (request === sequence) items.value = result
  }
  async function reorder(path: string, direction: 'up' | 'down'): Promise<void> {
    const request = ++sequence
    const result = await call('library:reorderPin', { path, direction })
    if (request === sequence) items.value = result
  }
  function connect(): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined
    const update = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void refresh().catch(e => useToastsStore().error((e as Error).message)), 100)
    }
    const offs = [on('library:pinsChanged', update), on('storage:changed', update), on('vault:changed', update), watch(() => useAppStore().vault.path, update)]
    update()
    return () => { clearTimeout(timer); offs.forEach(off => off()) }
  }
  watch(() => useAppStore().vault.path, () => { sequence++; items.value = [] }, { flush: 'sync' })
  return { items, isPinned, refresh, set, reorder, connect }
})
