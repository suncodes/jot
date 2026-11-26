<script setup lang="ts">
import { computed } from 'vue'
import { useLibraryStore } from '@/stores/library'
import { t } from '@/strings'
const { path } = defineProps<{ path: string }>()
const library = useLibraryStore()
const directories = computed(() => path.startsWith('content/') ? path.split('/').slice(1, -1).map((name, index, parts) => ({ name, path: 'content/' + parts.slice(0, index + 1).join('/') })) : [])
</script>
<template>
  <nav class="content-breadcrumb small muted" :aria-label="t.directory.position" data-testid="content-breadcrumb">
    <template v-if="path.startsWith('content/')"><button v-if="!directories.length" class="ghost" @click="library.select({ collection: 'all' })">{{ t.directory.root }}</button><template v-for="(directory, index) in directories" :key="directory.path"><span v-if="index">/</span><button class="ghost" @click="library.select({ directoryPath: directory.path })">{{ directory.name }}</button></template></template>
    <button v-else-if="path.startsWith('ideas/')" class="ghost" data-testid="breadcrumb-ideas" @click="library.select({ collection: 'ideas' })">{{ t.directory.ideasPosition }}</button>
    <button v-else-if="path.startsWith('inbox/')" class="ghost" data-testid="breadcrumb-pending" @click="library.select({ collection: 'pending' })">{{ t.directory.pendingPosition }}</button>
    <span v-else>{{ path.startsWith('journal/') ? t.directory.dailyPosition : t.directory.summaryPosition }}</span>
  </nav>
</template>
<style scoped>
.content-breadcrumb { display:flex; flex-wrap:wrap; align-items:center; gap:var(--space-1); min-width:0; overflow-wrap:anywhere; }
button { color:inherit; min-height:0; padding:0 var(--space-1); font-size:inherit; white-space:normal; text-align:left; }
</style>
