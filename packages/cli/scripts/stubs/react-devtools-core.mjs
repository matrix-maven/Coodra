// Bundle-time stub for `react-devtools-core` — Ink's optional devtools peer.
//
// The published `@coodra/cli` bundle never enables Ink
// devtools. `ink/build/reconciler.js` only `await import('./devtools.js')`
// — the module that imports `react-devtools-core` — AFTER a runtime
// `import.meta.resolve('react-devtools-core')` succeeds, and the package
// is not a dependency of the CLI, so that resolve always throws and the
// devtools chunk is never executed.
//
// esbuild still has to *resolve* the import to produce a loadable ESM
// bundle (a bare external would hoist to an eager top-level
// `import 'react-devtools-core'` that crashes Node at load). `bundle.mjs`
// aliases the package to this file: esbuild inlines this tiny no-op
// instead, the bundle resolves cleanly, and the unreachable devtools
// code path stays harmless even in the impossible case it ran.
const noop = () => {};

export default {
  connectToDevTools: noop,
};
