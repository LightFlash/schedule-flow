import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/** 共享层别名，三端统一使用，避免相对路径穿越。 */
const sharedAlias = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: { emptyOutDir: false },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: { emptyOutDir: false },
  },
  renderer: {
    root: resolve(__dirname),
    plugins: [react()],
    resolve: {
      alias: {
        ...sharedAlias,
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
    build: {
      outDir: 'out/renderer',
      emptyOutDir: false,
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
      },
    },
  },
})
