const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const bridge = window.deepLiveCam;
const { getSession, REALTIME_ENDPOINTS, RESOLUTION_STEPS, MIN_REFERENCE_IMAGE_DIMENSION } = window.LucySession;

const STATE_LABELS = {
  idle: "Idle",
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  error: "Error"
};

const elements = {
  html: document.documentElement,
  appVersion: $("#appVersion"),
  platformInfo: $("#platformInfo"),
  topStatus: $("#topStatus"),
  liveTimer: $("#liveTimer"),
  systemStatus: $("#systemStatus"),
  permissionStatus: $("#permissionStatus"),
  connectionSummary: $("#connectionSummary"),
  connectionDot: $("#connectionDot"),
  sourceVideo: $("#sourceVideo"),
  resultVideo: $("#resultVideo"),
  sourceEmpty: $("#sourceEmpty"),
  resultEmpty: $("#resultEmpty"),
  sourceState: $("#sourceState"),
  resultState: $("#resultState"),
  sourceBadge: $("#sourceBadge"),
  resultBadge: $("#resultBadge"),
  sourceResolution: $("#sourceResolution"),
  resultResolution: $("#resultResolution"),
  cameraError: $("#cameraError"),
  cameraErrorText: $("#cameraErrorText"),
  retryCamera: $("#retryCamera"),
  startBtn: $("#startBtn"),
  stopBtn: $("#stopBtn"),
  fullscreenBtn: $("#fullscreenBtn"),
  previewStage: $("#previewStage"),
  sessionTitle: $("#sessionTitle"),
  sessionDetail: $("#sessionDetail"),
  modeSummary: $("#modeSummary"),
  cameraSelect: $("#cameraSelect"),
  refreshCameras: $("#refreshCameras"),
  chooseFileBtn: $("#chooseFileBtn"),
  fileName: $("#fileName"),
  refWarning: $("#refWarning"),
  promptInput: $("#promptInput"),
  modeSelect: $("#modeSelect"),
  resolutionSelect: $("#resolutionSelect"),
  promptExpansion: $("#promptExpansion"),
  modeFact: $("#modeFact"),
  networkFact: $("#networkFact"),
  resolutionFact: $("#resolutionFact"),
  networkMeter: $("#networkMeter"),
  networkMeterLabel: $("#networkMeterLabel"),
  obsToggle: $("#obsToggle"),
  obsPanel: $("#obsPanel"),
  obsUrlField: $("#obsUrlField"),
  copyObsUrl: $("#copyObsUrl"),
  obsCanvas: $("#obsCanvas"),
  settingsPanel: $("#settingsPanel"),
  settingsToggle: $("#settingsToggle"),
  openSettingsNav: $("#openSettingsNav"),
  closeSettings: $("#closeSettings"),
  themeToggle: $("#themeToggle"),
  saveBtn: $("#saveBtn"),
  saveSettingsBtn: $("#saveSettingsBtn"),
  advancedBtn: $("#advancedBtn"),
  advancedDialog: $("#advancedDialog"),
  apiKeyInput: $("#apiKeyInput"),
  applyKey: $("#applyKey"),
  keyStatusText: $("#keyStatusText"),
  balanceText: $("#balanceText"),
  balanceSummary: $("#balanceSummary"),
  sidebarBalance: $("#sidebarBalance"),
  balanceVisibilityToggle: $("#balanceVisibilityToggle"),
  balanceVisibilityIcon: $("#balanceVisibilityIcon"),
  openFalDashboard: $("#openFalDashboard"),
  activityLog: $("#activityLog"),
  activityCount: $("#activityCount"),
  toastRegion: $("#toastRegion"),
  srStatus: $("#srStatus")
};

const state = {
  activityCount: 1,
  referenceImageUrl: undefined,
  balance: null,
  balanceVisible: false,
  lastLoggedState: "idle",
  lastSessionActive: false
};

let session;
let unsubscribeSession = () => {};

function announce(message) {
  elements.srStatus.textContent = "";
  window.setTimeout(() => { elements.srStatus.textContent = message; }, 20);
}

function toast(message) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  elements.toastRegion.append(node);
  announce(message);
  window.setTimeout(() => node.remove(), 2800);
}

function addActivity(message) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  const copy = document.createElement("span");
  time.textContent = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" }).format(new Date());
  copy.textContent = message;
  item.append(time, copy);
  elements.activityLog.prepend(item);
  while (elements.activityLog.children.length > 20) elements.activityLog.lastElementChild.remove();
  state.activityCount = Math.min(state.activityCount + 1, 20);
  elements.activityCount.textContent = `${state.activityCount} ${state.activityCount === 1 ? "event" : "events"}`;
}

// ---------------------------------------------------------------------
// fal.ai session wiring
// ---------------------------------------------------------------------

function currentEditParams() {
  return {
    prompt: elements.promptInput.value || undefined,
    referenceImageUrl: state.referenceImageUrl,
    enablePromptExpansion: elements.promptExpansion.checked
  };
}

function attachSession(mode) {
  unsubscribeSession();
  session = getSession(mode);
  session.setPreferredResolution(Number(elements.resolutionSelect.value));
  session.setPreferredDeviceId(elements.cameraSelect.value || undefined);
  session.updateEditParams(currentEditParams());
  unsubscribeSession = session.subscribe(render);
  render();
}

function bindVideo(videoEl, emptyEl, stream) {
  if (stream) {
    if (videoEl.srcObject !== stream) {
      videoEl.srcObject = stream;
      // Setting srcObject alone doesn't reliably start playback without the
      // `autoplay` attribute (and isn't reliable even with it, in practice)
      // — without this the element sits paused on a single frame forever.
      videoEl.play().catch((err) => console.error("[video] play() failed", err));
    }
    videoEl.classList.add("streaming");
    emptyEl.hidden = true;
  } else {
    videoEl.srcObject = null;
    videoEl.classList.remove("streaming");
    emptyEl.hidden = false;
  }
}

function render() {
  const snap = session.getSnapshot();
  const label = STATE_LABELS[snap.state];
  const chipClass = snap.state === "live" ? "running" : snap.state;

  elements.topStatus.className = `status-chip ${chipClass}`;
  $("span", elements.topStatus).textContent = label;
  elements.systemStatus.className = `system-state ${chipClass}`;
  elements.systemStatus.innerHTML = `<i></i>${snap.state === "idle" ? "System ready" : label}`;
  elements.connectionSummary.textContent = label;
  elements.connectionDot.className = `connection-dot ${snap.state}`;
  elements.connectionDot.setAttribute("aria-label", label);

  bindVideo(elements.sourceVideo, elements.sourceEmpty, snap.localStream);
  bindVideo(elements.resultVideo, elements.resultEmpty, snap.remoteStream);

  const selectedCamera = elements.cameraSelect.selectedOptions[0];
  elements.sourceBadge.textContent = snap.localStream ? (selectedCamera?.textContent || "Live camera") : "No camera";
  elements.resultBadge.textContent = snap.remoteStream ? "Live output" : "Waiting…";
  elements.sourceResolution.textContent = snap.localStream ? `${snap.resolution} × ${snap.resolution}` : "—";
  elements.resultResolution.textContent = snap.remoteStream ? `${snap.resolution} × ${snap.resolution}` : "—";

  const paneState = (kind, text) => `<i></i>${text}`;
  elements.sourceState.className = `pane-state ${snap.localStream ? "live" : "idle"}`;
  elements.sourceState.innerHTML = paneState(null, snap.localStream ? "Live" : "Idle");
  elements.resultState.className = `pane-state ${snap.remoteStream ? "live" : "waiting"}`;
  elements.resultState.innerHTML = paneState(null, snap.remoteStream ? "Live" : "Waiting");

  elements.networkFact.textContent = snap.networkQuality === "unknown" ? "—" : snap.networkQuality;
  elements.resolutionFact.textContent = `${snap.resolution} × ${snap.resolution}`;

  elements.networkMeter.dataset.quality = snap.networkQuality;
  const qualityLabel = snap.networkQuality === "unknown" ? "—" : snap.networkQuality[0].toUpperCase() + snap.networkQuality.slice(1);
  elements.networkMeterLabel.textContent = `Network ${qualityLabel}`;
  const qualityHints = {
    unknown: "Network quality isn't known yet.",
    good: "Connection is strong.",
    fair: "Connection is a little weak — this can make the swap slightly delayed.",
    poor: "Connection is weak right now — this is likely why the swap looks blocky, delayed, or inaccurate."
  };
  const hint = qualityHints[snap.networkQuality] || qualityHints.unknown;
  elements.networkMeter.setAttribute("aria-label", `Network quality: ${snap.networkQuality}. ${hint}`);
  elements.networkMeter.title = hint;

  elements.sessionTitle.textContent =
    snap.state === "live" ? "Live session running" : snap.state === "error" ? "Session needs attention" : "Ready to connect";
  elements.sessionDetail.textContent =
    snap.state === "live"
      ? "Frames are streaming out and back over WebRTC."
      : "Video streams directly between your camera and Miko.";

  if (snap.error) {
    elements.cameraError.hidden = false;
    elements.cameraErrorText.textContent = snap.error;
  } else {
    elements.cameraError.hidden = true;
  }

  const isLive = snap.state === "live";
  const isBusy = snap.state === "connecting" || snap.state === "reconnecting";
  elements.startBtn.disabled = isLive || isBusy;
  elements.stopBtn.disabled = snap.state === "idle";
  elements.modeSelect.disabled = isLive || isBusy;
  elements.resolutionSelect.disabled = isLive || isBusy;
  elements.cameraSelect.disabled = isLive || isBusy;
  $("span", elements.startBtn).textContent = isBusy ? "Connecting…" : isLive ? "Live" : "Start Live";

  if (snap.localStream) elements.permissionStatus.textContent = "Camera allowed";

  // Log meaningful transitions once, not on every stats-poll re-render.
  if (snap.state !== state.lastLoggedState) {
    if (snap.state === "live") { addActivity("Live session started"); startLiveTimer(); }
    else {
      if (snap.state === "idle" && state.lastLoggedState !== "idle") addActivity("Session stopped");
      else if (snap.state === "error") addActivity(`Error: ${snap.error || "connection failed"}`);
      else if (snap.state === "reconnecting") addActivity("Reconnecting…");
      stopLiveTimer();
    }
    state.lastLoggedState = snap.state;
  }

  const sessionActive = isLive || isBusy;
  if (sessionActive && !state.lastSessionActive && elements.obsToggle.checked) startObsFrameLoop();
  if (!sessionActive && state.lastSessionActive) clearTransientSessionMedia();
  state.lastSessionActive = sessionActive;
}

// ---------------------------------------------------------------------
// Camera enumeration
// ---------------------------------------------------------------------

async function refreshCameras(preserveValue = true) {
  const previous = preserveValue ? elements.cameraSelect.value : "";
  if (!navigator.mediaDevices?.enumerateDevices) {
    elements.cameraSelect.innerHTML = '<option value="">Camera API unavailable</option>';
    return;
  }
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    elements.cameraSelect.replaceChildren();
    elements.cameraSelect.append(new Option("System default", ""));
    devices.forEach((device, index) => elements.cameraSelect.append(new Option(device.label || `Camera ${index + 1}`, device.deviceId)));
    if (devices.some((device) => device.deviceId === previous)) elements.cameraSelect.value = previous;
  } catch (error) {
    elements.cameraSelect.innerHTML = '<option value="">Unable to list cameras</option>';
    addActivity(`Camera discovery failed: ${error.message || error}`);
  }
}

// ---------------------------------------------------------------------
// Reference image
// ---------------------------------------------------------------------

function readFileAsDataUri(fileUrl) {
  return fetch(fileUrl)
    .then((response) => response.blob())
    .then(
      (blob) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        })
    );
}

function loadImageDimensions(dataUri) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Could not read image dimensions"));
    img.src = dataUri;
  });
}

async function chooseReferenceImage() {
  let result;
  try {
    result = await bridge.pickMedia("image");
  } catch (error) {
    toast(`Could not open file picker: ${error?.message || error}`);
    return;
  }
  if (!result) return;

  elements.refWarning.hidden = true;
  try {
    const dataUri = await readFileAsDataUri(result.url);
    const { width, height } = await loadImageDimensions(dataUri);

    if (width < MIN_REFERENCE_IMAGE_DIMENSION || height < MIN_REFERENCE_IMAGE_DIMENSION) {
      elements.refWarning.hidden = false;
      elements.refWarning.className = "field-hint danger";
      elements.refWarning.textContent = `Image is ${width}×${height}px — needs at least ${MIN_REFERENCE_IMAGE_DIMENSION}×${MIN_REFERENCE_IMAGE_DIMENSION}px.`;
      return;
    }
    if (width < 768 || height < 768) {
      elements.refWarning.hidden = false;
      elements.refWarning.className = "field-hint warning";
      elements.refWarning.textContent = "Works, but 768–1024px references give noticeably better fidelity.";
    }

    state.referenceImageUrl = dataUri;
    elements.fileName.textContent = result.name;
    session.updateEditParams({ referenceImageUrl: dataUri });
    addActivity(`Reference image set: ${result.name}`);
    toast(`${result.name} selected`);
  } catch (error) {
    elements.refWarning.hidden = false;
    elements.refWarning.className = "field-hint danger";
    elements.refWarning.textContent = `Couldn't read that image: ${error?.message || error || "unknown error"}. Try a different file.`;
  }
}

// ---------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------

function collectSettings() {
  return {
    mode: elements.modeSelect.value,
    resolution: Number(elements.resolutionSelect.value),
    prompt: elements.promptInput.value,
    enablePromptExpansion: elements.promptExpansion.checked,
    cameraId: elements.cameraSelect.value,
    theme: elements.html.dataset.theme
  };
}

function applySettings(settings) {
  if (!settings) return;
  elements.modeSelect.value = settings.mode || REALTIME_ENDPOINTS.characterSwap;
  elements.resolutionSelect.value = String(settings.resolution || 1024);
  elements.promptInput.value = settings.prompt || "";
  elements.promptExpansion.checked = Boolean(settings.enablePromptExpansion);
  applyTheme(settings.theme || "dark", false);
  updateModeCopy();
}

async function saveSettings() {
  const result = await bridge.saveSettings(collectSettings());
  if (result?.ok) {
    toast("Settings saved locally");
    addActivity("Settings saved");
  } else {
    toast(result?.message || "Settings could not be saved");
  }
}

function applyTheme(theme, notify = true) {
  const value = theme === "light" ? "light" : "dark";
  elements.html.dataset.theme = value;
  elements.themeToggle.setAttribute("aria-label", value === "dark" ? "Switch to light theme" : "Switch to dark theme");
  if (notify) toast(`${value === "dark" ? "Dark" : "Light"} theme enabled`);
}

function updateModeCopy() {
  const isVton = elements.modeSelect.value === REALTIME_ENDPOINTS.virtualTryOn;
  const label = isVton ? "Virtual Try-on" : "Character Swap";
  elements.modeSummary.textContent = label;
  elements.modeFact.textContent = label;
}

// ---------------------------------------------------------------------
// fal.ai API key
// ---------------------------------------------------------------------

async function refreshKeyStatus() {
  const { hasKey, keyError } = await bridge.getKeyStatus();
  // "No key configured yet" would be actively misleading if a key was
  // saved but can no longer be read/decrypted — distinguish that case so
  // the user re-enters their key instead of assuming nothing was ever set.
  elements.keyStatusText.textContent = hasKey
    ? "A key is configured on this device."
    : keyError
      ? `Saved key is unusable: ${keyError} Re-enter it below.`
      : "No key configured yet.";
}

const LOW_BALANCE_THRESHOLD = 1.0;
let lastBalanceWarningShown = false;

function renderBalance() {
  const result = state.balance;
  const hasBalance = result && typeof result.balance === "number";
  elements.balanceSummary.hidden = !hasBalance;
  elements.balanceText.hidden = !hasBalance;
  if (!hasBalance) return;

  const formatted = `${result.balance.toFixed(2)} ${result.currency}`;
  const isLow = result.balance < LOW_BALANCE_THRESHOLD;
  const isZero = result.balance <= 0;
  const status = isZero ? "Out of credits" : isLow ? "Running low" : "Available";

  elements.balanceSummary.className = `balance-summary ${isZero ? "danger" : isLow ? "warning" : ""}`.trim();
  elements.sidebarBalance.textContent = state.balanceVisible ? formatted : "••••••";
  elements.sidebarBalance.classList.toggle("is-masked", !state.balanceVisible);
  elements.balanceVisibilityToggle.setAttribute("aria-pressed", String(state.balanceVisible));
  elements.balanceVisibilityToggle.setAttribute("aria-label", state.balanceVisible ? "Hide balance" : "Show balance");
  elements.balanceVisibilityToggle.title = state.balanceVisible ? "Hide balance" : "Show balance";
  elements.balanceVisibilityIcon.setAttribute("href", state.balanceVisible ? "#i-eye-off" : "#i-eye");

  elements.balanceText.className = `field-hint ${isZero ? "danger" : isLow ? "warning" : ""}`.trim();
  elements.balanceText.textContent = state.balanceVisible ? `Balance: ${formatted} — ${status.toLowerCase()}.` : `Balance hidden — ${status.toLowerCase()}.`;
}

async function refreshBalance({ notifyIfLow = false } = {}) {
  const result = await bridge.getBalance().catch((error) => {
    // Non-fatal by design (the app must still work if fal's billing
    // endpoint is unreachable or scoped out) — but silent-forever is its
    // own bug, so at least trace the real reason instead of just "null".
    console.warn("[balance] check failed:", error?.message || error);
    return null;
  });
  if (!result || typeof result.balance !== "number") {
    state.balance = null;
    renderBalance();
    return null;
  }

  state.balance = result;
  const formatted = `${result.balance.toFixed(2)} ${result.currency}`;
  const isLow = result.balance < LOW_BALANCE_THRESHOLD;
  const isZero = result.balance <= 0;
  renderBalance();

  if (notifyIfLow && isLow && !lastBalanceWarningShown) {
    lastBalanceWarningShown = true;
    toast(isZero ? `Out of credits (${formatted})` : `Balance running low (${formatted})`);
    addActivity(isZero ? `Balance is ${formatted} — sessions will fail until topped up` : `Balance is low: ${formatted}`);
  } else if (!isLow) {
    lastBalanceWarningShown = false;
  }

  return result;
}

// ---------------------------------------------------------------------
// OBS output — captures the Result video element to a hidden canvas and
// streams it to the main process as JPEG frames, which serves them to
// OBS's Browser Source over local HTTP (see main.js). No OBS plugin,
// WebSocket, or virtual camera driver required.
// ---------------------------------------------------------------------

const OBS_TARGET_FPS = 30;
const OBS_JPEG_QUALITY = 0.92; // high quality, per the request that this feed not look compressed/soft
let obsFrameTimer = null;

function startObsFrameLoop() {
  if (obsFrameTimer) return;
  const canvas = elements.obsCanvas;
  const ctx = canvas.getContext("2d");
  obsFrameTimer = window.setInterval(() => {
    const video = elements.resultVideo;
    if (!video.videoWidth) return;
    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        blob.arrayBuffer().then((buf) => bridge.obsSendFrame(buf));
      },
      "image/jpeg",
      OBS_JPEG_QUALITY
    );
  }, 1000 / OBS_TARGET_FPS);
}

function stopObsFrameLoop() {
  if (obsFrameTimer) {
    window.clearInterval(obsFrameTimer);
    obsFrameTimer = null;
  }
}

// ---------------------------------------------------------------------
// Live session timer — an in-app UI element only. OBS's feed is built by
// startObsFrameLoop() drawing just the <video id="resultVideo"> element's
// pixels onto a canvas (see below); this timer lives in a separate DOM
// element that loop never touches, so it can never end up in the OBS
// output no matter how it's styled or positioned.
// ---------------------------------------------------------------------

let liveTimerInterval = null;
let liveStartedAt = null;

function formatLiveDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

function startLiveTimer() {
  if (liveTimerInterval) return;
  liveStartedAt = Date.now();
  elements.liveTimer.hidden = false;
  elements.liveTimer.textContent = "00:00";
  liveTimerInterval = window.setInterval(() => {
    elements.liveTimer.textContent = formatLiveDuration(Date.now() - liveStartedAt);
  }, 1000);
}

function stopLiveTimer() {
  if (liveTimerInterval) {
    window.clearInterval(liveTimerInterval);
    liveTimerInterval = null;
  }
  liveStartedAt = null;
  elements.liveTimer.hidden = true;
}

function clearTransientSessionMedia() {
  stopObsFrameLoop();
  const canvas = elements.obsCanvas;
  const ctx = canvas.getContext("2d");

  // Push one blank frame so a connected OBS Browser Source does not freeze on
  // the final face, then discard even that frame from the main process. IPC
  // messages from this renderer are ordered, so the clear runs after the blank.
  if (canvas.width && canvas.height) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) {
        bridge.obsClearFrame();
        return;
      }
      blob.arrayBuffer().then((buffer) => {
        bridge.obsSendFrame(buffer);
        bridge.obsClearFrame();
      });
    }, "image/jpeg", 0.8);
  } else {
    bridge.obsClearFrame();
  }

  elements.resultVideo.srcObject = null;

  // The activity list is renderer-memory only, but clear it too so no
  // per-call timeline remains visible after teardown.
  elements.activityLog.replaceChildren();
  const item = document.createElement("li");
  const time = document.createElement("time");
  const copy = document.createElement("span");
  time.textContent = "Now";
  copy.textContent = "Previous session data cleared";
  item.append(time, copy);
  elements.activityLog.append(item);
  state.activityCount = 1;
  elements.activityCount.textContent = "1 event";
}

async function toggleObsOutput() {
  if (elements.obsToggle.checked) {
    try {
      const { url } = await bridge.obsStart();
      elements.obsUrlField.value = url;
      elements.obsPanel.hidden = false;
      startObsFrameLoop();
      addActivity("OBS output started");
      toast("OBS output is live — add it as a Browser Source");
    } catch (error) {
      elements.obsToggle.checked = false;
      toast(error.message || "Could not start OBS output");
      addActivity(`OBS output failed: ${error.message || error}`);
    }
  } else {
    stopObsFrameLoop();
    await bridge.obsStop();
    elements.obsPanel.hidden = true;
    addActivity("OBS output stopped");
  }
}

// ---------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------

function openSettings() {
  elements.settingsPanel.classList.add("is-open");
  window.setTimeout(() => elements.modeSelect.focus(), 210);
}

function bindEvents() {
  elements.startBtn.addEventListener("click", () => {
    void refreshBalance({ notifyIfLow: true }); // catch "out of credits" before it surfaces as a confusing connect failure
    session.connect().then(() => refreshCameras());
  });
  elements.stopBtn.addEventListener("click", () => {
    clearTransientSessionMedia();
    session.disconnect();
  });
  elements.retryCamera.addEventListener("click", () => session.connect());

  elements.balanceVisibilityToggle.addEventListener("click", () => {
    state.balanceVisible = !state.balanceVisible;
    renderBalance();
    announce(state.balanceVisible ? "Balance shown" : "Balance hidden");
  });

  elements.refreshCameras.addEventListener("click", async () => { await refreshCameras(); toast("Camera list refreshed"); });
  elements.cameraSelect.addEventListener("change", () => session.setPreferredDeviceId(elements.cameraSelect.value || undefined));

  elements.chooseFileBtn.addEventListener("click", chooseReferenceImage);
  elements.promptInput.addEventListener("input", () => session.updateEditParams({ prompt: elements.promptInput.value || undefined }));
  elements.promptExpansion.addEventListener("change", () => session.updateEditParams({ enablePromptExpansion: elements.promptExpansion.checked }));

  elements.modeSelect.addEventListener("change", () => {
    updateModeCopy();
    attachSession(elements.modeSelect.value);
  });
  elements.resolutionSelect.addEventListener("change", () => session.setPreferredResolution(Number(elements.resolutionSelect.value)));

  elements.fullscreenBtn.addEventListener("click", async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await elements.previewStage.requestFullscreen();
  });

  elements.themeToggle.addEventListener("click", () => applyTheme(elements.html.dataset.theme === "dark" ? "light" : "dark"));
  elements.settingsToggle.addEventListener("click", openSettings);
  elements.openSettingsNav.addEventListener("click", openSettings);
  elements.closeSettings.addEventListener("click", () => elements.settingsPanel.classList.remove("is-open"));
  elements.saveBtn.addEventListener("click", saveSettings);
  elements.saveSettingsBtn.addEventListener("click", saveSettings);

  elements.advancedBtn.addEventListener("click", async () => {
    await refreshKeyStatus();
    await refreshBalance();
    elements.advancedDialog.showModal();
  });
  elements.applyKey.addEventListener("click", async (event) => {
    const key = elements.apiKeyInput.value.trim();
    if (!key) { event.preventDefault(); toast("Enter a key first"); return; }
    event.preventDefault();
    try {
      await bridge.saveKey(key);
      elements.apiKeyInput.value = "";
      addActivity("API key saved");
      toast("API key saved");
      elements.advancedDialog.close();
      await refreshKeyStatus();
    } catch (error) {
      const message = error?.message || String(error);
      toast(`Could not save API key: ${message}`);
      addActivity(`API key save failed: ${message}`);
    }
  });
  elements.openFalDashboard.addEventListener("click", () => bridge.openExternal("https://fal.ai/dashboard/keys"));

  elements.obsToggle.addEventListener("change", toggleObsOutput);
  elements.copyObsUrl.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(elements.obsUrlField.value);
      toast("URL copied");
    } catch (error) {
      toast(`Could not copy URL: ${error?.message || error}`);
    }
  });

  $$("[data-window-action]").forEach((button) => button.addEventListener("click", () => bridge.windowControl(button.dataset.windowAction)));
  navigator.mediaDevices?.addEventListener?.("devicechange", () => refreshCameras());
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

async function init() {
  bindEvents();
  const [info, settings] = await Promise.all([bridge.appInfo(), bridge.loadSettings(), refreshCameras(false)]);
  if (info) {
    elements.html.dataset.platform = info.platform;
    elements.appVersion.textContent = `v${info.version}`;
    elements.platformInfo.textContent = `${info.platform} · ${info.architecture}`;
  }
  applySettings(settings);
  if (settings?.cameraId) elements.cameraSelect.value = settings.cameraId;

  attachSession(settings?.mode || REALTIME_ENDPOINTS.characterSwap);
  await refreshKeyStatus();
  void refreshBalance({ notifyIfLow: true });

  // Show the camera right away (a "lobby" preview) so the user can check
  // framing/lighting and pick a device before committing to a live,
  // concurrency-limited session — Start Live only needs to open the fal.ai
  // connection at that point, reusing this same stream.
  void session.previewCamera();
}

init().catch((error) => {
  console.error(error);
  toast(`Miko could not finish initializing: ${error?.message || error}`);
});

window.addEventListener("beforeunload", clearTransientSessionMedia);
