import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const PRELOAD_HELPER = '\0vite/preload-helper.js'

/**
 * Replaces Vite's module-preload helper with a pass-through.
 *
 * cubing.js runs its solvers in web workers that dynamically import puzzle
 * chunks. Vite wraps those imports in `__vitePreload`, which injects <link>
 * tags and therefore touches `document` -- undefined in a worker. The worker
 * threw "document is not defined" on load, so every scramble failed in a
 * production build while dev, which does not use the helper, looked fine.
 *
 * Preloading is a latency optimisation, not a correctness one: the stub still
 * performs the dynamic import, so the only cost is that solver chunks are
 * fetched when needed rather than a moment earlier. They are already loaded
 * on demand and only for the event being scrambled.
 */
function stubPreloadHelper(): Plugin {
  return {
    name: 'stub-vite-preload-helper',
    enforce: 'pre',
    resolveId(id) {
      return id === PRELOAD_HELPER ? id : null
    },
    load(id) {
      return id === PRELOAD_HELPER
        ? 'export function __vitePreload(baseModule){return baseModule()}'
        : null
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), stubPreloadHelper()],
  // Workers use native dynamic import rather than a bundled shim.
  worker: { format: 'es' },
})
