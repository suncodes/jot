<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { AlertCircle, ChevronRight, History } from 'lucide-vue-next'
import type { RunRecord } from '@shared/assistant'
import AssistantMessage from '@/components/assistant/AssistantMessage.vue'
import ToolProcess from '@/components/assistant/ToolProcess.vue'
import { useCapabilitiesStore } from '@/stores/capabilities'
import { formatRunTime } from '@/capabilities/presentation'
import { t } from '@/strings'
import CapabilityHeader from './CapabilityHeader.vue'
import ReasoningDetails from '@/components/ReasoningDetails.vue'
const { run } = defineProps<{ run: RunRecord }>()
const c = t.capabilities
const cap = useCapabilitiesStore()
const snapshot = ref<HTMLDetailsElement | null>(null)
const context = computed(() => run.message.context)
const calls = computed(() => run.message.parts?.some(part => part.type === 'tool') ? run.message.parts.flatMap(part => part.type === 'tool' ? [part.call] : []) : run.message.toolCalls ?? [])
const result = computed(() => ({ ...run.message, error: undefined, toolCalls: [], parts: run.message.parts?.filter(part => part.type === 'text') }))
const tone = computed(() => run.status === 'completed' ? 'success' : run.status === 'failed' ? 'danger' : 'muted')
const toolName = (id: string) => cap.catalog?.tools.find(tool => tool.id === id)?.title ?? id
async function viewConfig(): Promise<void> {
  if (!snapshot.value) return
  snapshot.value.open = true
  await nextTick()
  snapshot.value.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  snapshot.value.querySelector('summary')?.focus()
}
</script>
<template>
  <article class="cap-detail run-detail" data-testid="cap-run-detail">
    <CapabilityHeader :icon="History" :title="run.title" :description="`${context?.agent.name ?? c.defaultName} · ${formatRunTime(run.message.startedAt ?? run.time)}`" :status="c.statuses[run.status]" :tone><template #actions><button data-testid="cap-view-config" @click="viewConfig">{{ c.viewConfig }}</button><slot name="actions" /></template></CapabilityHeader>
    <div class="cap-run-summary" data-testid="cap-run-summary"><div><span>{{ c.runStarted }}</span><strong>{{ run.message.startedAt ? formatRunTime(run.message.startedAt) : c.notRecorded }}</strong></div><div><span>{{ c.duration }}</span><strong>{{ run.message.durationMs !== undefined ? c.seconds(run.message.durationMs) : c.notRecorded }}</strong></div><div><span>{{ c.toolCalls }}</span><strong>{{ c.calls(calls.length) }}</strong></div></div>
    <div v-if="run.message.error" class="cap-notice" :class="{ danger: run.status === 'failed' }" data-testid="cap-run-error"><AlertCircle :size="15" /><p>{{ run.message.error }}</p></div>
    <section class="cap-section"><h3>{{ c.resultSummary }}</h3><div v-if="run.message.text" class="cap-run-result"><AssistantMessage :message="result" /></div><p v-else class="small muted">{{ c.noResult }}</p></section>
    <section class="cap-section cap-run-steps"><h3>{{ c.toolSteps }}<span class="cap-count">{{ calls.length }}</span></h3><ToolProcess v-if="calls.length" :calls standalone /><p v-else class="small muted">{{ c.noSteps }}</p></section>
    <details ref="snapshot" class="cap-disclosure snapshot" data-testid="cap-run-snapshot"><summary><ChevronRight :size="13" />{{ c.runSnapshot }}</summary><template v-if="context"><dl class="cap-metadata"><dt>{{ c.title }}</dt><dd>{{ context.agent.name }}</dd><dt>{{ c.model }}</dt><dd>{{ context.modelUse?.channelName ? context.modelUse.channelName + ' / ' : '' }}{{ context.modelUse?.name || context.model || c.notRecorded }}</dd><dt>{{ c.skills }}</dt><dd>{{ context.skills.map(skill => skill.title).join('、') || c.noSkillsSnapshot }}</dd><dt>{{ c.tools }}</dt><dd>{{ context.agent.toolIds.map(toolName).join('、') || c.noTools }}</dd><dt>{{ c.runBasis }}</dt><dd>{{ context.strict ? c.strictBasis : c.referenceBasis }} · {{ context.references.map(reference => reference.title).join('、') || t.agent.noMaterials }}</dd></dl><ReasoningDetails v-if="context.reasoning" :reasoning="context.reasoning" /><div class="cap-instruction selectable">{{ context.agent.instructions }}</div><details v-for="reference in context.references" :key="reference.kind + reference.value" class="cap-disclosure"><summary><ChevronRight :size="13" />{{ reference.title }}</summary><p class="cap-section-caption selectable">{{ reference.value }}</p><p class="cap-section-caption">{{ t.agent.currentMaterial }}</p></details></template><p v-else class="small muted">{{ c.noSnapshot }}</p></details>
  </article>
</template>
