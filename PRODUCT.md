# Product

## Register

product

## Users

Creators and technical operators who need a focused desktop workspace for configuring and running a real-time camera transformation session. The primary task is selecting a camera, setting a prompt and reference image, checking the live source and output, and starting or stopping a session without leaving the application.

## Product Purpose

Miko is a distributable Electron control surface for fal.ai's Decart Lucy 2.5 realtime model: live camera preview, prompt and reference-image configuration, and a WebRTC session against fal.ai's hosted API (no local GPU or Python backend required — see `README.md` for the architecture). Success means the user can confidently prepare a session, understand system state at a glance, and get a working live character swap or virtual try-on with minimal setup beyond their own fal.ai key.

## Brand Personality

Precise, capable, restrained. The application should feel like a dependable production console: technically credible without becoming intimidating, dense without becoming cluttered, and responsive without decorative spectacle.

## Anti-references

Avoid neon cyberpunk dashboards, decorative glassmorphism, purple-gradient AI branding, toy-like oversized controls, and mock controls that imply functionality they do not provide.

## Design Principles

- Put the live source and output state ahead of secondary configuration.
- Make every control communicate whether it is available, active, loading, successful, or in error.
- Prefer familiar desktop affordances and keyboard-accessible controls over novel interaction patterns.
- Separate the Electron shell from the fal.ai inference backend through a narrow, explicit bridge — the key never reaches the renderer.
- Keep technical detail available without forcing it into the primary workflow.

## Accessibility & Inclusion

Target WCAG 2.1 AA contrast, complete keyboard navigation, visible focus states, semantic labels, non-color status cues, and reduced-motion support. Camera permission failures, missing devices, and unsupported media must be explained in plain language with a recovery action.
