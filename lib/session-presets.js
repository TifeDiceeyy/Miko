(function exposeSessionPresets(root, factory) {
  const presets = factory();
  if (typeof module === "object" && module.exports) module.exports = presets;
  if (root) root.MikoSessionPresets = presets;
})(typeof globalThis === "undefined" ? undefined : globalThis, function createSessionPresets() {
  // Model = which endpoint (and therefore which per-second rate) a session
  // uses. Task = what the prompt asks for. They are independent on purpose:
  // any model may be sent any task, including Lite with a full character swap.
  const MODELS = Object.freeze({
    pro: "decart/lucy-2-5/realtime",
    lite: "decart/lucy2-vton/realtime"
  });

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

  function promptAfterTaskChange(currentPrompt, fromTask, toTask) {
    return currentPrompt === DEFAULT_PROMPTS[fromTask] ? DEFAULT_PROMPTS[toTask] : currentPrompt;
  }

  return Object.freeze({
    MODELS,
    MODEL_NAMES,
    TASKS,
    TASK_LABELS,
    DEFAULT_PROMPTS,
    resolveSelection,
    promptAfterTaskChange
  });
});
