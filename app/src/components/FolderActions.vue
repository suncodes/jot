<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TreeNode } from '@shared/types'
import { call } from '@/api'
import ObjectMenu from '@/components/ObjectMenu.vue'
import AppDialog from '@/components/AppDialog.vue'
import ContentDirectorySelect from './ContentDirectorySelect.vue'
import AppSelect from '@/components/AppSelect.vue'
import { prepareContentAction } from '@/utils/pendingEdits'
import { canManageFolder, folderArea, type MenuAction } from '@/utils/objectActions'
import { useTabsStore } from '@/stores/tabs'
import { useLibraryPinsStore } from '@/stores/pins'
import { useToastsStore } from '@/stores/toasts'
import { t } from '@/strings'
const { path, createOnly = false, label = '' } = defineProps<{ path: string; createOnly?: boolean; label?: string }>()
const menu = ref<InstanceType<typeof ObjectMenu> | null>(null)
const tabs = useTabsStore()
const toasts = useToastsStore()
const pins = useLibraryPinsStore()
const mode = ref('')
const value = ref('')
const folders = ref<string[]>([])
const count = ref(0)
const busy = ref(false)
const error = ref('')
const actions = computed<MenuAction[]>(() => {
  const list: MenuAction[] = []
  if (folderArea(path) === 'content') list.push({ id: 'note', label: t.actions.newNote, testId: 'menu-new' })
  if (folderArea(path)) list.push({ id: 'folder', label: t.actions.newFolder, testId: 'menu-folder' })
  if (!createOnly && canManageFolder(path)) list.push({ id: 'rename', label: t.actions.rename, separated: true }, { id: 'move', label: t.actions.move })
  if (!createOnly && path.startsWith('content/')) list.push({ id: 'pin', label: pins.isPinned(path) ? t.pins.remove : t.pins.add })
  if (!createOnly) list.push({ id: 'copy', label: t.actions.copyPath })
  if (!createOnly && canManageFolder(path)) list.push({ id: 'delete', label: t.actions.trash, danger: true, separated: true })
  return list.map((a) => ({ ...a, testId: a.testId ?? 'folder-' + a.id }))
})
async function prepare(): Promise<void> {
  await pins.refresh().catch(e => toasts.error((e as Error).message))
}
const title = computed(() => ({ note: t.actions.newNote, folder: t.actions.newFolder, rename: t.actions.rename, move: t.actions.move, delete: t.actions.trash })[mode.value as 'note'])
async function choose(action: string): Promise<void> {
  try {
    if (action === 'pin') { await pins.set(path, 'folder', !pins.isPinned(path)); return }
    if (action === 'copy') { await navigator.clipboard.writeText(path); toasts.info(t.actions.copied); return }
    value.value = action === 'rename' ? path.split('/').pop()! : action === 'move' ? path.split('/').slice(0, -1).join('/') : ''
    if (action === 'note') {
      const meta = await call('doc:create', { dir: path === 'content' ? undefined : path, title: t.files.newNoteTitle })
      await tabs.open(meta.path, { newTab: true, startEditing: true })
      return
    }
    if (action === 'move' || action === 'delete') {
      const tree = await call('vault:tree', {})
      const dirs: string[] = []
      let children = 0
      const walk = (nodes: TreeNode[]): void => {
        for (const node of nodes) {
          if (node.kind === 'dir') { dirs.push(node.path); walk(node.children ?? []) }
          else if (node.path.startsWith(path + '/')) children++
        }
      }
      walk(tree)
      count.value = children
      folders.value = dirs.filter((d) => folderArea(d) === folderArea(path) && d !== path && !d.startsWith(path + '/'))
    }
    if (action === 'move' && path.startsWith('content/')) value.value = 'root'
    error.value = ''; mode.value = action
  } catch (e) { toasts.error((e as Error).message) }
}
async function submit(): Promise<void> {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    await prepareContentAction()
    const currentPath = path
    if (mode.value === 'folder') await call('vault:createFolder', { parent: currentPath, name: value.value.trim() })
    else if (mode.value === 'rename' || mode.value === 'move') {
      const result = await call('folder:move', {
        path: currentPath,
        toDir: mode.value === 'rename' ? currentPath.split('/').slice(0, -1).join('/') : value.value === 'root' ? 'content' : value.value,
        ...(mode.value === 'rename' ? { name: value.value.trim() } : {}),
      })
      for (const p of result.paths) tabs.retarget(p.from, p.to)
      if (result.notUpdated?.length) toasts.error(t.library.linksNotUpdated + result.notUpdated.map(item => item.path).join('、'))
      toasts.info(mode.value === 'rename' ? t.actions.renamed : t.actions.moved)
    } else {
      const { trashId } = await call('folder:delete', { path: currentPath })
      for (const tab of [...tabs.tabs]) if (tab.path.startsWith(currentPath + '/')) tabs.close(tab.path)
      toasts.info(t.actions.deleted, { label: t.actions.undo, run: async () => { await call('folder:restore', { trashId }) } })
    }
    mode.value = ''
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
defineExpose({ open: (event: MouseEvent) => menu.value?.open(event) })
</script>
<template>
  <ObjectMenu ref="menu" :actions :prepare="createOnly ? undefined : prepare" :label="label || (createOnly ? t.actions.create : t.actions.more)" :icon="createOnly ? 'plus' : 'more'" :trigger-id="createOnly ? 'tree-new' : 'folder-more'" menu-id="tree-menu" @select="choose" />
  <AppDialog v-if="mode" :title :busy :compact="mode === 'rename' || mode === 'folder'" @close="mode = ''">
    <form @submit.prevent="submit">
      <p class="small muted selectable">{{ path }}</p>
      <label v-if="mode === 'folder' || mode === 'rename'" class="dialog-field">
        {{ t.actions.name }}
        <input v-model="value" class="dialog-input" type="text" maxlength="80" autofocus data-select-on-open data-testid="folder-name" />
      </label>
      <label v-if="mode === 'move'">{{ t.actions.target }}<ContentDirectorySelect v-if="path.startsWith('content/')" v-model="value" :exclude-path="path" data-testid="folder-target" /><AppSelect v-else v-model="value" :label="t.actions.target" :options="folders.map((p) => ({ value: p, label: p }))" searchable data-testid="folder-target" /></label>
      <p v-if="mode === 'delete'">{{ t.actions.folderHint }} {{ t.actions.folderCount(count) }}</p>
      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
      <div class="dialog-actions"><button type="button" class="ghost" :disabled="busy" @click="mode = ''">{{ t.actions.cancel }}</button><button class="primary" :disabled="busy || (mode !== 'delete' && !value.trim())" data-testid="folder-confirm">{{ busy ? t.actions.busy : mode === 'delete' ? t.actions.trash : t.actions.confirm }}</button></div>
    </form>
  </AppDialog>
</template>
