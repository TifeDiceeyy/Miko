(function exposeSessionPresets(root, factory) {
  const presets = factory();
  if (typeof module === "object" && module.exports) module.exports = presets;
  if (root) root.MikoSessionPresets = presets;
})(typeof globalThis === "undefined" ? undefined : globalThis, function createSessionPresets() {
  // Model = which endpoint (and therefore which per-second rate) a session
  // uses. Task = what the prompt asks for. This module stays agnostic of
  // product policy — it will resolve/migrate any model+task combination
  // given to it. The UI (app.js's syncTaskOptionsForModel()) is what
  // actually restricts "character" to Pro only: a live 2026-09-14 session
  // confirmed Lite (decart/lucy2-vton/realtime, fal's virtual-try-on model)
  // bills normally but does not perform a full character swap, only
  // outfit/garment edits — see AGENTS.md hard-won fact #7a.
  const MODELS = Object.freeze({
    pro: "decart/lucy-2-5/realtime",
    lite: "decart/lucy2-vton/realtime"
  });

  // Key suppliers. "fal" is the original path; "decart" uses Decart's own
  // API. Miko's model choices stay the same; each supplier runs its own model
  // for them (Decart: lucy-2.5 swaps, lucy-vton-3.5 dresses). Exact names, not
  // "-latest" aliases: the SDK's lucy-latest runs at a different size.
  const SUPPLIERS = Object.freeze(["fal", "decart"]);
  const DECART_MODELS = Object.freeze({
    [MODELS.pro]: "lucy-2.5",
    [MODELS.lite]: "lucy-vton-3.5"
  });

  function resolveSupplier(value) {
    return value === "decart" ? "decart" : "fal";
  }

  // The model the supplier actually runs, and bills, for a Miko model choice.
  function backendModel(model, supplier) {
    return resolveSupplier(supplier) === "decart" ? DECART_MODELS[model] || DECART_MODELS[MODELS.pro] : model;
  }

  const MODEL_NAMES = Object.freeze({
    [MODELS.pro]: "Miko Pro",
    [MODELS.lite]: "Miko Lite"
  });

  const TASKS = Object.freeze(["character", "outfit"]);

  const TASK_LABELS = Object.freeze({
    character: "Full character swap",
    outfit: "Outfit only"
  });

  const DEFAULT_PROMPTS = Object.freeze({
    character:
      "Replace the entire person in the live camera feed with the exact person or character shown in the reference image, including their face, facial features, hair, skin tone, body appearance, clothing, colors, materials, and silhouette. Keep the same identity and character design stable and consistent across every frame. Preserve the live person's pose, expression, hand motion, camera angle, lighting, and background. Do not invent, blend, or morph facial features, clothing, or identity.",
    outfit:
      "Dress the person in the live camera feed in the exact garment shown in the reference image, matching its color, material, pattern, fit, and details. Keep the person's face, identity, pose, body shape, and background unchanged."
  });

  // Decart's own defaults, worded the way its prompting guides recommend
  // ("Replace the character in the video with … from the reference image",
  // "Substitute the outfit with …"), with no filler words. fal's defaults
  // above are unchanged.
  const DECART_DEFAULT_PROMPTS = Object.freeze({
    character:
      "Replace the character in the video with the person or character from the reference image. Match their face, hair, skin tone, body shape, clothing, colors, and materials exactly as shown in the reference. Keep the live person's pose, expression, hand motion, camera angle, and background.",
    outfit:
      "Substitute the outfit with the garment from the reference image, matching its color, fabric, pattern, fit, and details exactly as shown."
  });

  // Decart rejects prompts longer than about this many characters.
  const DECART_PROMPT_MAX_CHARS = 750;

  function defaultPrompt(task, supplier) {
    const prompts = resolveSupplier(supplier) === "decart" ? DECART_DEFAULT_PROMPTS : DEFAULT_PROMPTS;
    return prompts[task] || prompts.character;
  }

  function isDefaultPrompt(prompt) {
    return [...Object.values(DEFAULT_PROMPTS), ...Object.values(DECART_DEFAULT_PROMPTS)].includes(prompt);
  }

  // A prompt still at any default follows the chosen task and supplier; one
  // the user wrote (or left empty) is kept as it is.
  function promptFor(currentPrompt, task, supplier) {
    return isDefaultPrompt(currentPrompt) ? defaultPrompt(task, supplier) : currentPrompt;
  }

  // Settings saved before the model/task split only have `mode`, which was
  // the endpoint and implied the task (Lite meant outfit try-on). Keep those
  // installs behaving exactly as before.
  function resolveSelection(source) {
    const input = source && typeof source === "object" ? source : {};
    const models = Object.values(MODELS);
    const model = models.includes(input.model)
      ? input.model
      : models.includes(input.mode)
        ? input.mode
        : MODELS.pro;
    const task = TASKS.includes(input.task)
      ? input.task
      : input.mode === MODELS.lite
        ? "outfit"
        : "character";
    return { model, task };
  }

  function promptAfterTaskChange(currentPrompt, fromTask, toTask, supplier = "fal") {
    return promptFor(currentPrompt, toTask, supplier);
  }

  return Object.freeze({
    MODELS,
    MODEL_NAMES,
    SUPPLIERS,
    DECART_MODELS,
    resolveSupplier,
    backendModel,
    TASKS,
    TASK_LABELS,
    DEFAULT_PROMPTS,
    DECART_DEFAULT_PROMPTS,
    DECART_PROMPT_MAX_CHARS,
    defaultPrompt,
    isDefaultPrompt,
    promptFor,
    resolveSelection,
    promptAfterTaskChange
  });
});
