import { build } from "esbuild";

// Two small build steps for the renderer — main.js and preload.js stay plain
// CommonJS with no bundler, per the rest of this project's style. Output
// lands in dist/ so the page can load each bundle with a plain <script> tag,
// no module loader needed.
const common = {
  bundle: true,
  sourcemap: true,
  platform: "browser",
  format: "iife",
  target: "chrome120",
  logLevel: "info",
};

// fal session logic, loaded by index.html on every launch. Its options must
// not change because of the Decart bundle below.
await build({
  ...common,
  entryPoints: ["lib/renderer-entry.ts"],
  outfile: "dist/lucy-session.bundle.js",
});

// Decart session logic (@decartai/sdk and livekit-client, about 1 MB
// minified), loaded by app.js only when Decart is the key supplier.
await build({
  ...common,
  entryPoints: ["lib/decart-entry.ts"],
  outfile: "dist/decart-session.bundle.js",
  minify: true,
});
