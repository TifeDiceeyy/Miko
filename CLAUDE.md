# CLAUDE.md

Guidance for Claude Code working in this repository.

**Read `AGENTS.md` first.** It's the full install/build/run guide plus the
hard-won implementation facts (fal.ai's undocumented WebRTC signaling
protocol, token-minting quirks, why certain features were explicitly
rejected, and how to test this app without a human clicking through the
UI). Everything in it applies equally here — it's kept as one file instead
of two so Claude Code and Codex/other assistants never drift out of sync.

Quick pointers specific to this file's role:

- User-facing overview and architecture diagram: `README.md`.
- UI/product design rationale: `PRODUCT.md`.
- This is an Electron + TypeScript project. `main.js`/`preload.js`/`app.js`
  are plain CommonJS/browser JS (no bundler, no build step — verify with
  `npm run check`). `lib/*.ts` is bundled by esbuild
  (`npm run build`/`npm run typecheck`).
- No automated test suite exists. See "Testing without a human" in
  `AGENTS.md` for the CDP-based approach used throughout this project.
