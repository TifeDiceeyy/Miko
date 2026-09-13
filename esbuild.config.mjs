import { build } from "esbuild";

// One small build step, isolated to the fal.ai session logic — main.js and
// preload.js stay plain CommonJS with no bundler, per the rest of this
// project's style. Output lands next to app.js so index.html can load it
// with a plain <script> tag before app.js, no module loader needed.
await build({
  entryPoints: ["lib/renderer-entry.ts"],
  outfile: "dist/lucy-session.bundle.js",
  bundle: true,
  sourcemap: true,
  platform: "browser",
  format: "iife",
  target: "chrome120",
  logLevel: "info",
});
