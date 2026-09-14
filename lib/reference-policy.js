(function exposeReferencePolicy(root, factory) {
  const policy = factory();
  if (typeof module === "object" && module.exports) module.exports = policy;
  if (root) root.MikoReferencePolicy = policy;
})(typeof globalThis === "undefined" ? undefined : globalThis, function createReferencePolicy() {
  function computeReferenceSize(width, height) {
    if (!(width > 0 && height > 0)) throw new Error("Reference dimensions must be positive.");
    let sourceX = 0;
    let sourceY = 0;
    let sourceWidth = width;
    let sourceHeight = height;

    // Keep the short edge at least 512 after the 1280px cap by center-cropping
    // unusually wide/tall images to a maximum 2:1 aspect ratio.
    if (sourceWidth / sourceHeight > 2) {
      sourceWidth = sourceHeight * 2;
      sourceX = (width - sourceWidth) / 2;
    } else if (sourceHeight / sourceWidth > 2) {
      sourceHeight = sourceWidth * 2;
      sourceY = (height - sourceHeight) / 2;
    }

    // fal/Decart's own reference-image guidance: "maintain sharp quality at
    // ~1280px longest side." The cap used to be 1024px, needlessly
    // downscaling sharper references below what the model itself expects.
    const scale = Math.min(1, 1280 / Math.max(sourceWidth, sourceHeight));
    return {
      width: Math.round(sourceWidth * scale),
      height: Math.round(sourceHeight * scale),
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight
    };
  }

  return Object.freeze({ computeReferenceSize });
});
