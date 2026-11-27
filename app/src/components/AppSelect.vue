<script setup lang="ts" generic="T extends string = string">
import { Check, ChevronDown, Search } from 'lucide-vue-next'
import { computed, nextTick, ref, useId, watch } from 'vue'
import { usePopover } from '@/composables/usePopover'
import { t } from '@/strings'

defineOptions({ inheritAttrs: false })
const { options, label, searchable = false, disabled = false } = defineProps<{
  options: readonly { value: T; label: string; disabled?: boolean; group?: string }[]
  label: string
  searchable?: boolean
  disabled?: boolean
}>()
const value = defineModel<T>({ required: true })
const { anchor, panel, open, position, show, close, toggle } = usePopover()
const id = useId()
const query = ref('')
const search = ref<HTMLInputElement | null>(null)
const active = ref(0)
const selected = computed(() => options.find((o) => o.value === value.value))
const filtered = computed(() => options.filter((o) => o.label.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())))
const activeId = computed(() => id + '-option-' + active.value)

async function expand(): Promise<void> {
  if (disabled) return
  query.value = ''
  active.value = Math.max(0, options.findIndex((o) => o.value === value.value))
  await show()
  if (searchable) search.value?.focus()
  scrollActive()
}
function scrollActive(): void {
  void nextTick(() => document.getElementById(activeId.value)?.scrollIntoView({ block: 'nearest' }))
}
function pick(index: number): void {
  const option = filtered.value[index]
  if (!option || option.disabled) return
  value.value = option.value
  close(true)
}
function move(delta: number): void {
  const length = filtered.value.length
  for (let n = 1; n <= length; n++) {
    const index = (active.value + delta * n + length) % length
    if (!filtered.value[index]?.disabled) { active.value = index; break }
  }
  scrollActive()
}
function keyboard(e: KeyboardEvent): void {
  if (disabled || e.isComposing) return
  if (e.key === 'Tab') { if (open.value) close(true); return }
  if (!open.value && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
    e.preventDefault(); void expand(); return
  }
  if (!open.value) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1) }
  else if (e.key === 'Enter' || (e.key === ' ' && !searchable)) { e.preventDefault(); pick(active.value) }
  else if (e.key === 'Home' && !searchable) { e.preventDefault(); active.value = 0; scrollActive() }
  else if (e.key === 'End' && !searchable) { e.preventDefault(); active.value = filtered.value.length - 1; scrollActive() }
}
watch(query, () => { active.value = Math.max(0, filtered.value.findIndex((o) => !o.disabled)); scrollActive() })
watch(() => disabled, (v) => { if (v) close() })
</script>

<template>
  <div ref="anchor" class="app-select">
    <button v-bind="$attrs" type="button" class="select-control" role="combobox" :data-value="value" :aria-label="label" aria-haspopup="listbox" :aria-expanded="open" :aria-controls="open ? id : undefined" :aria-activedescendant="open ? activeId : undefined" :disabled="disabled" @click="open ? toggle() : expand()" @keydown="keyboard">
      <span>{{ selected?.label ?? label }}</span><ChevronDown :size="14" aria-hidden="true" />
    </button>
    <Teleport :to="anchor?.closest('dialog') ?? 'body'">
      <div v-if="open" ref="panel" class="select-popover" :style="position" @keydown="keyboard">
        <div v-if="searchable" class="select-search"><Search :size="14" /><input ref="search" v-model="query" type="text" :aria-label="t.controls.searchOptions" :placeholder="t.controls.searchOptions" :aria-controls="id" :aria-activedescendant="activeId" /></div>
        <div :id="id" class="options" role="listbox" :aria-label="label" data-testid="select-options">
          <div v-if="!filtered.length" class="no-options muted">{{ t.controls.noOptions }}</div>
          <template v-for="(option, i) in filtered" :key="option.value"><div v-if="option.group && (i === 0 || filtered[i - 1]?.group !== option.group)" class="option-group" role="presentation">{{ option.group }}</div><div :id="id + '-option-' + i" role="option" class="option" :class="{ active: i === active, disabled: option.disabled }" :aria-selected="option.value === value" :aria-disabled="option.disabled || undefined" :data-value="option.value" :data-group="option.group" @pointermove="active = i" @mousedown.prevent @click="pick(i)">
            <span>{{ option.label }}</span><Check v-if="option.value === value" :size="14" aria-hidden="true" />
          </div></template>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.app-select { display:inline-block; min-width:0; vertical-align:middle; }
.select-control { display:flex; align-items:center; justify-content:space-between; gap:var(--space-3); width:100%; min-height:var(--control-height); padding:var(--space-2) var(--space-3); background:var(--bg-primary); border:1px solid var(--border); border-radius:var(--radius-m); font-size:var(--font-size-small); text-align:left; }
.select-control span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.select-control svg { flex:none; color:var(--text-muted); }
.select-control[aria-expanded='true'] { border-color:var(--accent); }
.select-popover { z-index:200; display:flex; flex-direction:column; padding:var(--space-1); border:1px solid var(--border); border-radius:var(--radius-m); background:var(--bg-primary); box-shadow:var(--shadow); overflow:hidden; font-size:var(--font-size-small); }
.select-search { display:flex; align-items:center; gap:var(--space-2); padding:var(--space-2); border-bottom:1px solid var(--border); color:var(--text-muted); }
.select-search input { width:100%; min-width:0; border:none; padding:0; border-radius:0; }
.options { overflow:auto; min-height:0; padding:var(--space-1) 0; }
.option { display:flex; align-items:center; justify-content:space-between; gap:var(--space-3); min-height:var(--control-height); padding:var(--space-2) var(--space-3); border-radius:var(--radius-s); cursor:pointer; overflow-wrap:anywhere; }
.option-group { padding:var(--space-2) var(--space-3) var(--space-1); color:var(--text-faint); font-size:11px; }
.option.active { background:var(--bg-hover); }
.option[aria-selected='true'] { color:var(--accent); background:var(--accent-soft); }
.option.disabled { color:var(--text-faint); cursor:default; }
.no-options { padding:var(--space-3); }
</style>
