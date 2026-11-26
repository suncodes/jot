<script setup lang="ts">
import { Plus } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { SynonymGroup, TermKind } from '@shared/types'
import { ApiError, call, on } from '@/api'
import { prepareContentAction } from '@/utils/pendingEdits'
import { useToastsStore } from '@/stores/toasts'
import AppSelect from '@/components/AppSelect.vue'
import AppDialog from '@/components/AppDialog.vue'
import TaxonomyRow from '@/components/TaxonomyRow.vue'
import { t } from '@/strings'

// 标签、人物和地点的管理：预置词条、查看用量、重命名、合并和检查同义。
const toasts = useToastsStore()
const kinds = ['tag', 'place', 'person'] as const
const kind = ref<TermKind>('tag')
const failures = ref<{ path: string; message: string }[]>([])
const creating = ref(false)
const newName = ref('')
const createBusy = ref(false)
const createError = ref('')
const removing = ref<string | null>(null)
const removeInto = ref('')
const removeBusy = ref(false)
const removeError = ref('')
const rows = ref<{ name: string; count: number; candidate: boolean }[]>([])
const selected = reactive(new Set<string>())
const keep = ref('')
const suggestions = ref<SynonymGroup[]>([])
const chosen = reactive<Record<string, string>>({})
const checking = ref(false)
const checked = ref(false)
const analysisNote = ref('')
const offs: (() => void)[] = []

const mine = computed(() => suggestions.value.filter((s) => s.kind === kind.value))
const mergeCount = computed(() => rows.value.filter((r) => selected.has(r.name) && r.name !== keep.value).reduce((n, r) => n + r.count, 0))

let loadSequence = 0
async function load(): Promise<void> {
  const request = ++loadSequence
  try {
    const [terms, groups] = await Promise.all([
      call('taxonomy:terms', { kind: kind.value }),
      call('taxonomy:synonyms'),
    ])
    if (request !== loadSequence) return
    rows.value = terms.map(term => ({ name: term.name, count: term.count, candidate: term.state === 'candidate' }))
    for (const name of [...selected]) if (!rows.value.some(r => r.name === name)) selected.delete(name)
    suggestions.value = groups
    for (const s of groups) chosen[s.id] ??= s.suggested
  } catch (e) {
    if (request === loadSequence) fail(e)
  }
}
watch(kind, () => {
  selected.clear()
  keep.value = ''
  checking.value = false
  checked.value = false; analysisNote.value = ''
  void load()
})

function toggle(name: string): void {
  if (selected.has(name)) selected.delete(name)
  else selected.add(name)
  if (!selected.has(keep.value)) keep.value = [...selected][0] ?? ''
}

const fail = (e: unknown) => toasts.error(e instanceof ApiError ? e.message : String(e))

function openCreate(): void {
  newName.value = ''
  createError.value = ''
  creating.value = true
}
async function create(): Promise<void> {
  if (createBusy.value || !newName.value.trim()) return
  createBusy.value = true
  createError.value = ''
  try {
    await call('taxonomy:create', { kind: kind.value, name: newName.value })
    creating.value = false
  } catch (e) { createError.value = (e as Error).message }
  finally { createBusy.value = false }
}

async function rename(from: string, to: string): Promise<void> {
  if (!to || to === from) return
  const sourceKind = kind.value
  try {
    await prepareContentAction()
    const r = await call('taxonomy:rename', { kind: sourceKind, from, to })
    failures.value = r.failed
    toasts.info(t.taxonomy.renamed(r.affected))
    await load()
  } catch (err) {
    fail(err)
  }
}

async function merge(from: string[], into: string): Promise<void> {
  try {
    await prepareContentAction()
    const r = await call('taxonomy:merge', { kind: kind.value, from: from.filter((n) => n !== into), into })
    failures.value = r.failed
    toasts.info(t.taxonomy.merged(r.affected))
    selected.clear()
    keep.value = ''
    await load()
  } catch (err) {
    fail(err)
  }
}

async function remove(): Promise<void> {
  if (!removing.value || removeBusy.value) return
  removeBusy.value = true
  try {
    await prepareContentAction()
    const result = await call('taxonomy:remove', { kind: kind.value, name: removing.value, into: removeInto.value || undefined })
    failures.value = result.failed
    removing.value = null
    selected.clear()
    await load()
    toasts.info(t.taxonomy.assignmentChanged)
  } catch (e) { removeError.value = (e as Error).message }
  finally { removeBusy.value = false }
}
async function findSynonyms(): Promise<void> {
  checking.value = true
  checked.value = false; analysisNote.value = ''
  try {
    await call('taxonomy:findSynonyms', { kind: kind.value })
  } catch (err) {
    checking.value = false
    fail(err)
  }
}

async function dismiss(s: SynonymGroup): Promise<void> {
  await call('taxonomy:dismissSynonym', { id: s.id })
  await load()
}

onMounted(() => {
  void load()
  offs.push(
    on('taxonomy:changed', () => void load()),
    on('jobs:updated', ({ job }) => {
      // 检查失败（比如模型不可用）时不要一直转圈
      if (job?.type !== 'find-synonyms' || job.target !== t.taxonomy.kinds[kind.value]) return
      if (job.state === 'done') {
        checking.value = false
        checked.value = true
        analysisNote.value = job.note ?? ''
      } else if (job.state === 'failed' || job.state === 'waiting-model' || job.state === 'cancelled') {
        checking.value = false
        if (job.error) toasts.error(job.error)
      }
    }),
    on('files:changed', () => void load()),
  )
})
onUnmounted(() => offs.forEach((off) => off()))
</script>

<template>
  <div class="taxonomy" data-testid="taxonomy-view">
    <header class="bar">
      <h2>{{ t.taxonomy.title }}</h2>
      <div class="kinds">
        <button v-for="k in kinds" :key="k" class="ghost kind" :class="{ on: kind === k }" :data-testid="`taxonomy-kind-${k}`" @click="kind = k">{{ t.taxonomy.kinds[k] }}</button>
      </div>
      <span class="grow" />
      <button :disabled="checking || rows.length < 2" data-testid="taxonomy-find" @click="findSynonyms">{{ checking ? t.taxonomy.checking : t.taxonomy.findSynonyms }}</button>
      <button type="button" class="primary create-term" data-testid="taxonomy-create" @click="openCreate"><Plus :size="15" />{{ t.taxonomy.newTerm }}</button>
    </header>


<div v-if="failures.length" class="dialog-error small" role="alert" data-testid="taxonomy-partial"><p>{{ t.taxonomy.partial(failures.length) }}</p><div v-for="failure in failures" :key="failure.path">{{ failure.path }}：{{ failure.message }}</div></div>
    <section v-if="mine.length || checked" class="suggestions" data-testid="taxonomy-suggestions">
      <h3 class="small">{{ t.taxonomy.suggestions }}</h3>
      <p v-if="analysisNote" class="small faint" data-testid="taxonomy-analysis-note">{{ analysisNote }}</p>
      <div v-if="!mine.length" class="small faint" data-testid="taxonomy-no-suggestions">{{ t.taxonomy.noSuggestions }}</div>
      <div v-for="s in mine" :key="s.id" class="suggestion small" data-testid="taxonomy-suggestion">
        <div class="names">
          <label v-for="n in s.names" :key="n" class="pick"><input v-model="chosen[s.id]" type="radio" :value="n" :name="s.id" /> {{ n }}</label>
          <span v-if="s.reason" class="faint">{{ s.reason }}</span>
        </div>
        <span class="faint">{{ t.taxonomy.keep }}「{{ chosen[s.id] }}」</span>
        <button class="primary" data-testid="suggestion-merge" @click="merge(s.names, chosen[s.id] ?? s.suggested)">{{ t.taxonomy.doMerge }}</button>
        <button class="ghost" data-testid="suggestion-ignore" @click="dismiss(s)">{{ t.taxonomy.ignore }}</button>
      </div>
    </section>

    <div v-if="selected.size >= 2" class="mergebar small" data-testid="taxonomy-mergebar">
      <span>{{ t.taxonomy.mergeInto }}</span>
      <AppSelect v-model="keep" :label="t.taxonomy.keep" :options="[...selected].map((n) => ({ value: n, label: n }))" data-testid="taxonomy-keep" />
      <span class="muted">{{ t.taxonomy.confirmMerge([...selected].filter((n) => n !== keep).join('、'), keep, mergeCount) }}</span>
      <button class="primary" data-testid="taxonomy-merge" @click="merge([...selected], keep)">{{ t.taxonomy.doMerge }}</button>
    </div>
    <div v-else class="small faint hint">{{ t.taxonomy.mergeHint }}</div>

    <div v-if="!rows.length" class="faint empty" data-testid="taxonomy-empty">{{ t.taxonomy.empty }}{{ t.taxonomy.kinds[kind] }}</div>
    <section v-if="rows.length" class="taxonomy-list small" :aria-label="t.taxonomy.kinds[kind]">
      <div class="list-head muted" data-testid="taxonomy-columns" aria-hidden="true">
        <span />
        <span>{{ t.taxonomy.name }}</span>
        <span class="count-head">{{ t.taxonomy.related }}</span>
        <span />
      </div>
      <ul class="list" data-object-list tabindex="-1" :aria-label="t.taxonomy.kinds[kind]">
        <TaxonomyRow v-for="r in rows" :key="kind + ':' + r.name" v-bind="r" :selected="selected.has(r.name)"
          @toggle="toggle(r.name)" @rename="rename(r.name, $event)"
          @remove="removing = r.name; removeInto = ''; removeError = ''" />
      </ul>
    </section>

    <AppDialog v-if="creating" :title="t.taxonomy.newTermTitle(t.taxonomy.kinds[kind])" :busy="createBusy" compact @close="creating = false">
      <form @submit.prevent="create">
        <label class="dialog-field">
          {{ t.taxonomy.name }}
          <input v-model="newName" class="dialog-input" type="text" maxlength="40" :disabled="createBusy" autofocus data-testid="taxonomy-create-name" @input="createError = ''" />
        </label>
        <p v-if="createError" class="dialog-error" role="alert" data-testid="taxonomy-create-error">{{ createError }}</p>
        <div class="dialog-actions">
          <button type="button" class="ghost" :disabled="createBusy" @click="creating = false">{{ t.common.cancel }}</button>
          <button class="primary" :disabled="createBusy || !newName.trim()" data-testid="taxonomy-create-confirm">{{ createBusy ? t.actions.busy : t.actions.save }}</button>
        </div>
      </form>
    </AppDialog>

    <AppDialog v-if="removing" :title="t.taxonomy.removeAssignment" :busy="removeBusy" @close="removing = null">
      <form @submit.prevent="remove">
        <p>{{ t.taxonomy.removeHint(removing) }}</p>
        <label>{{ t.actions.destination }}<AppSelect v-model="removeInto" :label="t.actions.destination" :options="[{ value: '', label: t.actions.detach }, ...rows.filter((r) => r.name !== removing).map((r) => ({ value: r.name, label: t.taxonomy.moveTo(r.name) }))]" data-testid="taxonomy-remove-target" /></label>
        <p v-if="removeError" class="dialog-error" role="alert">{{ removeError }}</p>
        <div class="dialog-actions"><button type="button" :disabled="removeBusy" @click="removing = null">{{ t.common.cancel }}</button><button class="primary" :disabled="removeBusy" data-testid="taxonomy-remove-confirm">{{ removeInto ? t.taxonomy.confirmMove : t.taxonomy.confirmDetach }}</button></div>
      </form>
    </AppDialog>
  </div>
</template>

<style scoped>
.taxonomy {
  height: 100%;
  overflow: auto;
  padding: var(--space-4) 24px 48px;
}
.taxonomy > * {
  max-width: var(--line-width);
  margin-left: auto;
  margin-right: auto;
}
.bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-bottom: var(--space-3);
}
.create-term { display:inline-flex; align-items:center; gap:var(--space-1); }
h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}
.kinds {
  display: flex;
  gap: 2px;
}
.kind.on {
  background: var(--bg-active);
  color: var(--accent);
}
.grow {
  flex: 1;
}
.suggestions {
  margin-bottom: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--accent);
  border-radius: var(--radius-m);
}
.suggestions h3 {
  margin: 0 0 var(--space-2);
  font-weight: 600;
}
.suggestion {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) 0;
}
.names {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-3);
}
.pick {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.mergebar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  margin-bottom: var(--space-2);
  border-radius: var(--radius-m);
  background: var(--bg-secondary);
}
.mergebar .muted {
  flex: 1;
}
.hint {
  margin-bottom: var(--space-2);
  min-height: 20px;
}
.empty {
  padding: 32px 0;
}
.list {
  list-style: none;
  margin: 0 auto;
  padding: 0;
}
.taxonomy-list {
  --taxonomy-menu-size: 32px;
  --taxonomy-row-height: 44px;
  --taxonomy-columns: var(--space-4) minmax(0, 1fr) 88px var(--taxonomy-menu-size);
}
.list-head {
  display: grid;
  grid-template-columns: var(--taxonomy-columns);
  align-items: center;
  gap: var(--space-3);
  min-height: var(--control-height);
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--border);
}
.count-head { text-align: right; }
@container content (max-width: 600px) {
  .taxonomy { padding: var(--space-4) var(--space-4) var(--space-8); }
}
</style>
