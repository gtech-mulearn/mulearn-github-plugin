import { defineConfig } from "tsup";

// The leaderboard plugin-runner loads remote plugins by fetching the JS and
// importing it as a `data:` URL. A data-URL module cannot resolve bare imports,
// so the published bundle MUST be a single self-contained ESM file with NO
// runtime imports. This config bundles everything and relies only on Node/Web
// globals (fetch, crypto, TextEncoder, btoa, atob).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "neutral", // force use of globals, never node: builtins
  bundle: true,
  splitting: false,
  treeshake: true,
  clean: true,
  minify: false,
  dts: false,
});
