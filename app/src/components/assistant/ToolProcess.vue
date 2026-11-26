<script setup lang="ts">
import { t } from '@/strings'
import { call as invoke } from '@/api'
import { prepareContentAction } from '@/utils/pendingEdits'
import { computed, ref } from 'vue'
import { Check, ChevronRight, Circle, LoaderCircle, Wrench, X } from 'lucide-vue-next'
import type { ToolCall } from '@shared/assistant'
const { calls, streaming = false, standalone = false, runId = undefined } = defineProps<{ calls: ToolCall[]; streaming?: boolean; standalone?: boolean; runId?: string }>()
const c = t.agent
const manual = ref<boolean | null>(null)
const submitting = ref(false)
const error = ref('')
const active = computed(() => calls.find(call => call.ok === undefined))
const pending = computed(() => streaming && calls.some(call => call.confirmation?.state === 'pending'))
const expanded = computed(() => pending.value || (manual.value ?? (streaming && !!active.value || calls.some(call => call.ok === false))))
const state = (call: ToolCall) => call.confirmation?.state === 'pending' ? streaming ? c.confirmPending : c.unfinished : call.ok === true ? c.completed : call.ok === false ? c.partialFailure : streaming ? c.executing : c.unfinished
const confirmationState = (call: ToolCall) => call.confirmation?.state === 'approved' ? c.confirmApproved : call.confirmation?.state === 'rejected' ? c.confirmRejected : streaming ? c.confirmPending : c.unfinished
const format = (input: unknown) => typeof input === 'string' ? input : JSON.stringify(input, null, 2)
async function decide(tool: ToolCall, approved: boolean): Promise<void> {
  if (!runId || !streaming || tool.confirmation?.state !== 'pending' || submitting.value) return
  submitting.value = true; error.value = ''
  try {
    if (approved) await prepareContentAction()
    await invoke('agent:confirm', { runId, requestId: tool.confirmation.id, approved })
  } catch (e) { error.value = (e as Error).message }
  finally { submitting.value = false }
}
defineExpose({ expand: () => { manual.value = true } })
</script>
<template>
  <component :is="standalone ? 'div' : 'details'" class="process" :open="standalone ? undefined : expanded" data-testid="agent-process">
    <summary v-if="!standalone" @click.prevent="manual = !expanded"><ChevronRight :size="13" class="chevron" /><LoaderCircle v-if="streaming && active && !pending" :size="14" class="spin" /><Wrench v-else :size="14" /><span class="process-label">{{ pending ? c.confirmPending : streaming && active ? active.summary : calls.some(call => call.ok === false) ? c.process + ' · ' + c.partialFailure : c.process }}</span><span class="process-count">· {{ c.callCount(calls.length) }}</span></summary>
    <div class="process-steps">
      <details v-for="(call, index) in calls" :key="call.id ?? index" class="tool-step" :open="call.ok === false || call.confirmation?.state === 'pending'" data-testid="agent-tool">
        <summary><span class="step-status" :class="{ failed: call.ok === false, running: call.ok === undefined && streaming }"><Check v-if="call.ok" :size="12" /><X v-else-if="call.ok === false" :size="12" /><LoaderCircle v-else-if="streaming && call.confirmation?.state !== 'pending'" :size="12" class="spin" /><Circle v-else :size="12" /></span><span class="step-copy"><span class="step-title"><span v-if="standalone">{{ index + 1 }}. </span>{{ call.summary }}</span><span v-if="!standalone" class="step-result">{{ state(call) }}</span></span><span v-if="standalone && call.durationMs !== undefined" class="step-duration">{{ t.capabilities.seconds(call.durationMs) }}</span><ChevronRight :size="13" class="chevron" /></summary>
        <div class="tool-detail">
          <section v-if="call.confirmation" class="tool-confirmation" data-testid="agent-confirmation" :aria-label="call.confirmation.title">
            <strong>{{ call.confirmation.title }} · {{ confirmationState(call) }}</strong>
            <ul class="selectable"><li v-for="target in call.confirmation.targets" :key="target.action + target.path">{{ target.path }}</li></ul>
            <template v-if="streaming && runId && call.confirmation.state === 'pending'">
              <p>{{ c.confirmHint }}</p>
              <div class="tool-confirmation-actions"><button class="primary" :disabled="submitting" data-testid="agent-confirm-approve" @click="decide(call, true)">{{ c.confirmAction }}</button><button :disabled="submitting" data-testid="agent-confirm-reject" @click="decide(call, false)">{{ c.cancelAction }}</button></div>
              <p v-if="error" class="failed" role="alert">{{ error }}</p>
            </template>
          </section>
          <dl><dt>{{ c.toolName }}</dt><dd>{{ call.name }}</dd><template v-if="call.id"><dt>{{ c.callId }}</dt><dd>{{ call.id }}</dd></template><dt>{{ c.toolState }}</dt><dd>{{ state(call) }}</dd><template v-if="call.durationMs !== undefined"><dt>{{ c.duration }}</dt><dd>{{ (call.durationMs / 1000).toFixed(1) }} s</dd></template></dl>
          <template v-if="call.input !== undefined"><h4>{{ c.toolInput }}</h4><pre class="selectable">{{ format(call.input) }}</pre></template>
          <template v-if="call.output !== undefined"><h4>{{ c.toolOutput }}</h4><pre class="selectable">{{ call.output }}</pre></template>
          <p v-if="call.input === undefined && call.output === undefined">{{ c.legacyTool }}</p>
        </div>
      </details>
    </div>
  </component>
</template>
