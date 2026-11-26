<script setup lang="ts">
import { Keyboard, X } from 'lucide-vue-next'
import { ref } from 'vue'
import { normalizeShortcut, isReservedShortcut } from '@shared/shortcut-keys'
import { t } from '@/strings'
const value = defineModel<string>({ required: true })
const { label = t.shortcuts.hotkey, disabled = false } = defineProps<{ label?: string; disabled?: boolean }>()
const recording = ref(false)
const error = ref('')
function keydown(event: KeyboardEvent): void {
  if (!recording.value || event.isComposing || event.keyCode === 229 || event.repeat || event.getModifierState('AltGraph')) return
  event.stopPropagation()
  if (event.key === 'Tab') { recording.value = false; return }
  event.preventDefault()
  if (event.key === 'Escape') { recording.value = false; error.value = ''; return }
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return
  try {
    const key = event.key === ' ' ? 'Space' : event.key
    const next = normalizeShortcut([event.ctrlKey ? 'Ctrl' : '', event.metaKey ? 'Meta' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', key].filter(Boolean).join('+'))
    if (isReservedShortcut(next)) { error.value = t.shortcuts.reserved; return }
    value.value = next; recording.value = false; error.value = ''
  } catch (e) { error.value = (e as Error).message }
}
</script>
<template>
  <div class="shortcut-recorder">
    <div class="settings-actions">
      <button type="button" :aria-label="label" :aria-pressed="recording" :disabled data-testid="shortcut-record" @click="recording = !recording; error = ''" @keydown.capture="keydown" @blur="recording = false"><Keyboard :size="14" /><kbd v-if="value && !recording">{{ value }}</kbd><span v-else>{{ recording ? t.shortcuts.recording : t.shortcuts.record }}</span></button>
      <button v-if="value" type="button" class="ghost icon-button" :disabled :title="t.shortcuts.clear" :aria-label="t.shortcuts.clear" data-testid="shortcut-clear" @click="value = ''; error = ''; recording = false"><X :size="14" /></button>
    </div>
    <p v-if="recording" class="small muted">{{ t.shortcuts.recordHint }}</p>
    <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
  </div>
</template>
<style scoped>
.shortcut-recorder { min-width:0; }
p { margin:var(--space-1) 0 0; }
kbd { font-family:var(--font-mono); font-size:var(--font-size-small); }
[aria-pressed='true'] { border-color:var(--accent); color:var(--accent); }
</style>
