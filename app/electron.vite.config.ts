import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'electron-vite'

const alias = { '@shared': resolve(import.meta.dirname, 'shared') }

export default defineConfig({
  main: {
    resolve: { alias },
    build: { rollupOptions: { input: { index: resolve(import.meta.dirname, 'electron/main.ts') } } },
  },
  preload: {
    resolve: { alias },
    build: {
      // 预加载脚本运行在沙箱里，必须是 CommonJS，并且把依赖打进去
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'electron/preload.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src'),
    resolve: { alias: { ...alias, '@': resolve(import.meta.dirname, 'src') } },
    plugins: [vue()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/index.html'),
          capture: resolve(import.meta.dirname, 'src/capture.html'),
        },
      },
    },
  },
})
