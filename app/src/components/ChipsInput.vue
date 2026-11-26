<script setup lang="ts">
import { X } from 'lucide-vue-next'
import { ref, useId } from 'vue'
import { t } from '@/strings'

// 可增删的标签输入：回车或逗号添加，退格删除最后一个，输入时提示已有的词。
const { modelValue, options = [], placeholder = '', testid, inputId } = defineProps<{ modelValue: string[]; options?: string[]; placeholder?: string; testid: string; inputId: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()
const text = ref('')
const listId = useId()

function add(): void {
  const input = text.value.trim()
  const value = options.includes(input) ? input : input.replace(/^#/, '').replace(/[,，]$/, '').trim()
  text.value = ''
  if (value && !modelValue.includes(value)) emit('update:modelValue', [...modelValue, value])
}
function remove(item: string): void {
  emit('update:modelValue', modelValue.filter((x) => x !== item))
}
function onKeydown(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
    e.preventDefault()
    add()
  } else if (e.key === 'Backspace' && !text.value && modelValue.length) {
    remove(modelValue.at(-1)!)
  }
}
</script>

<template>
  <div class="chips" :data-testid="testid">
    <span v-for="item in modelValue" :key="item" class="chip small" data-testid="chip">
      <span class="chip-text" :title="item">{{ item }}</span>
      <button class="ghost x" type="button" data-testid="chip-remove" :aria-label="t.props.removeValue(item)" @click="remove(item)"><X :size="12" aria-hidden="true" /></button>
    </span>
    <input :id="inputId" v-model="text" type="text" :list="listId" :placeholder="placeholder" :data-testid="`${testid}-input`" @keydown="onKeydown" @blur="add" @change="add" />
    <datalist :id="listId">
      <option v-for="o in options.filter(value => !modelValue.includes(value))" :key="o" :value="o" />
    </datalist>
  </div>
</template>

<style scoped>
.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--control-height);
  padding: var(--space-1);
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
}
.chips:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-width: 100%;
  min-height: var(--space-5);
  padding: 0 var(--space-1) 0 var(--space-2);
  border-radius: var(--radius-s);
  background: var(--bg-active);
  line-height: 1.4;
}
.chip-text {
  min-width: 0;
  max-width: 18em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.x {
  display: grid;
  place-items: center;
  flex: none;
  width: var(--space-5);
  min-height: var(--space-5);
  padding: 0;
  color: var(--text-muted);
}
.x:hover { color: var(--text-normal); }
input {
  flex: 1 1 9ch;
  min-width: 0;
  border: none;
  padding: 0 var(--space-2);
  background: transparent;
  font-size: inherit;
}
input:focus { border: none; box-shadow: none; }
</style>
