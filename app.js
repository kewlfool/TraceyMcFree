"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  const elements = {
    canvas: $("traceCanvas"),
    statusBadge: $("statusBadge"),
    startUploadButton: $("startUploadButton"),
    startProjectSelect: $("startProjectSelect"),
    imageInput: $("imageInput"),
    drawerToggle: $("drawerToggle"),
    controlDrawer: $("controlDrawer"),
    tabButtons: Array.from(document.querySelectorAll(".tab-btn")),
    tabPanels: Array.from(document.querySelectorAll(".tab-panel")),
    replaceImageButton: $("replaceImageButton"),
    removeImageButton: $("removeImageButton"),
    imageLockButton: $("imageLockButton"),
    imageOpacityRange: $("imageOpacityRange"),
    imageOpacityValue: $("imageOpacityValue"),
    resetCameraButton: $("resetCameraButton"),
    cameraLockButton: $("cameraLockButton"),
    cameraOpacityRange: $("cameraOpacityRange"),
    cameraOpacityValue: $("cameraOpacityValue"),
    cameraZoomRange: $("cameraZoomRange"),
    cameraZoomValue: $("cameraZoomValue"),
    grayscaleToggle: $("grayscaleToggle"),
    resetEditButton: $("resetEditButton"),
    brightnessRange: $("brightnessRange"),
    brightnessValue: $("brightnessValue"),
    contrastRange: $("contrastRange"),
    contrastValue: $("contrastValue"),
    exposureRange: $("exposureRange"),
    exposureValue: $("exposureValue"),
    gridToggle: $("gridToggle"),
    gridSizeRange: $("gridSizeRange"),
    gridSizeValue: $("gridSizeValue"),
    gridOpacityRange: $("gridOpacityRange"),
    gridOpacityValue: $("gridOpacityValue"),
    gridColorInput: $("gridColorInput"),
    projectSelect: $("projectSelect"),
    projectNameInput: $("projectNameInput"),
    saveProjectButton: $("saveProjectButton"),
    loadProjectButton: $("loadProjectButton"),
    deleteProjectButton: $("deleteProjectButton")
  };

  const ctx = elements.canvas.getContext("2d", { alpha: false });
  if (!ctx) return;

  const imageSourceCanvas = document.createElement("canvas");
  const imageSourceCtx = imageSourceCanvas.getContext("2d", { willReadFrequently: true });
  const imageFilteredCanvas = document.createElement("canvas");
  const imageFilteredCtx = imageFilteredCanvas.getContext("2d", { willReadFrequently: true });
  const cameraVideo = document.createElement("video");

  if (!imageSourceCtx || !imageFilteredCtx) return;

  cameraVideo.autoplay = true;
  cameraVideo.muted = true;
  cameraVideo.playsInline = true;
  cameraVideo.setAttribute("playsinline", "true");

  const state = {
    viewport: {
      width: 1,
      height: 1,
      dpr: Math.min(3, window.devicePixelRatio || 1)
    },
    rafId: 0,
    needsRender: true,
    awaitingImage: false,
    drawerOpen: true,
    activeTab: "image",
    filterDebounceId: 0,
    wakeLockRequested: true,
    wakeLockSentinel: null,
    pointers: new Map(),
    gesture: null,
    filters: {
      grayscale: false,
      brightness: 0,
      contrast: 0,
      exposure: 0
    },
    grid: {
      enabled: false,
      size: 40,
      opacity: 30,
      color: "#ffffff"
    },
    image: {
      loaded: false,
      sourceCanvas: imageSourceCanvas,
      filteredCanvas: imageFilteredCanvas,
      filterKey: "",
      filterPending: false,
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      opacity: 0.7,
      locked: false
    },
    camera: {
      active: false,
      stream: null,
      video: cameraVideo,
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      opacity: 1,
      locked: false
    }
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const LEGACY_PROJECT_STORAGE_KEY = "tracelite.project.v1";
  const PROJECT_STORAGE_KEY = "tracelite.projects.v2";
  const MAX_PROJECT_NAME_LENGTH = 40;
  const clampByte = (value) => {
    if (value <= 0) return 0;
    if (value >= 255) return 255;
    return Math.round(value);
  };

  const pointerDistance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const pointerAngle = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
  const pointerCenter = (a, b) => ({ x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 });

  function angleDelta(current, start) {
    let delta = current - start;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return delta;
  }

  function normalizeAngle(angle) {
    let value = angle;
    while (value > Math.PI) value -= Math.PI * 2;
    while (value < -Math.PI) value += Math.PI * 2;
    return value;
  }

  function layerByName(name) {
    return name === "camera" ? state.camera : state.image;
  }

  function isLayerDrawable(name) {
    if (name === "camera") {
      return state.camera.active && state.camera.video.videoWidth > 0;
    }
    return state.image.loaded;
  }

  function getGestureLayerName() {
    return state.activeTab === "camera" ? "camera" : "image";
  }

  function setStatus(message, isError = false) {
    elements.statusBadge.textContent = message;
    elements.statusBadge.classList.toggle("error", isError);
  }

  function setAwaitingImage(awaiting) {
    state.awaitingImage = awaiting;
    document.body.classList.toggle("awaiting-image", awaiting);
    setDrawerOpen(!awaiting);
  }

  function setDrawerOpen(open) {
    state.drawerOpen = open;
    elements.controlDrawer.classList.toggle("open", open);
    elements.drawerToggle.setAttribute("aria-expanded", String(open));
    elements.drawerToggle.textContent = open ? "Hide" : "Controls";
  }

  function setActiveTab(tab) {
    state.activeTab = tab;
    elements.tabButtons.forEach((button) => {
      const isActive = button.dataset.tab === tab;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
    });
    elements.tabPanels.forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.tabPanel === tab);
    });
  }

  function syncImageControls() {
    elements.imageOpacityRange.value = state.image.opacity.toFixed(2);
    elements.imageOpacityValue.textContent = state.image.opacity.toFixed(2);

    elements.imageLockButton.classList.toggle("is-lock-on", state.image.locked);
    elements.imageLockButton.setAttribute("aria-pressed", String(state.image.locked));
    elements.imageLockButton.textContent = state.image.locked ? "Image Locked" : "Image Lock";
  }

  function syncCameraControls() {
    elements.cameraOpacityRange.value = state.camera.opacity.toFixed(2);
    elements.cameraOpacityValue.textContent = state.camera.opacity.toFixed(2);
    elements.cameraZoomRange.value = state.camera.scale.toFixed(2);
    elements.cameraZoomValue.textContent = `${state.camera.scale.toFixed(2)}x`;

    elements.cameraLockButton.classList.toggle("is-lock-on", state.camera.locked);
    elements.cameraLockButton.setAttribute("aria-pressed", String(state.camera.locked));
    elements.cameraLockButton.textContent = state.camera.locked ? "Camera Locked" : "Camera Lock";
  }

  function syncEditControls() {
    elements.grayscaleToggle.checked = state.filters.grayscale;
    elements.brightnessRange.value = String(state.filters.brightness);
    elements.brightnessValue.textContent = String(state.filters.brightness);
    elements.contrastRange.value = String(state.filters.contrast);
    elements.contrastValue.textContent = String(state.filters.contrast);
    elements.exposureRange.value = state.filters.exposure.toFixed(1);
    elements.exposureValue.textContent = state.filters.exposure.toFixed(1);
  }

  function syncGridControls() {
    elements.gridToggle.checked = state.grid.enabled;
    elements.gridSizeRange.value = String(state.grid.size);
    elements.gridSizeValue.textContent = `${state.grid.size}px`;
    elements.gridOpacityRange.value = String(state.grid.opacity);
    elements.gridOpacityValue.textContent = `${state.grid.opacity}%`;
    elements.gridColorInput.value = state.grid.color;
  }

  function resizeCanvas() {
    state.viewport.width = Math.max(1, window.innerWidth);
    state.viewport.height = Math.max(1, window.innerHeight);
    state.viewport.dpr = Math.min(3, window.devicePixelRatio || 1);

    elements.canvas.width = Math.round(state.viewport.width * state.viewport.dpr);
    elements.canvas.height = Math.round(state.viewport.height * state.viewport.dpr);
    elements.canvas.style.width = `${state.viewport.width}px`;
    elements.canvas.style.height = `${state.viewport.height}px`;
    requestRender();
  }

  function requestRender() {
    state.needsRender = true;
    if (!state.rafId) {
      state.rafId = window.requestAnimationFrame(renderFrame);
    }
  }

  function renderFrame() {
    state.rafId = 0;
    if (!state.needsRender && !state.camera.active) return;

    drawScene();
    state.needsRender = false;

    if (state.camera.active || state.needsRender) {
      state.rafId = window.requestAnimationFrame(renderFrame);
    }
  }

  function drawScene() {
    const { width, height, dpr } = state.viewport;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    if (state.camera.active) {
      drawCameraLayer(width, height);
    }
    if (state.image.loaded) {
      drawImageLayer(width, height);
    }
    if (state.grid.enabled) {
      drawGrid(width, height);
    }
  }

  function drawLayer(source, sourceWidth, sourceHeight, layer, canvasWidth, canvasHeight) {
    if (!source || !sourceWidth || !sourceHeight) return;

    const fitScale = Math.min(canvasWidth / sourceWidth, canvasHeight / sourceHeight);
    const drawWidth = sourceWidth * fitScale * layer.scale;
    const drawHeight = sourceHeight * fitScale * layer.scale;
    const centerX = canvasWidth * 0.5 + (layer.x / 100) * canvasWidth;
    const centerY = canvasHeight * 0.5 + (layer.y / 100) * canvasHeight;

    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(layer.rotation);
    ctx.globalAlpha = clamp(layer.opacity, 0, 1);
    ctx.drawImage(source, -drawWidth * 0.5, -drawHeight * 0.5, drawWidth, drawHeight);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawImageLayer(canvasWidth, canvasHeight) {
    const source = getImageSourceForRendering();
    if (!source) return;
    drawLayer(source, source.width, source.height, state.image, canvasWidth, canvasHeight);
  }

  function drawCameraLayer(canvasWidth, canvasHeight) {
    const video = state.camera.video;
    if (!video.videoWidth || !video.videoHeight) return;

    drawLayer(
      video,
      video.videoWidth,
      video.videoHeight,
      state.camera,
      canvasWidth,
      canvasHeight
    );
  }

  function hexToRgb(hex) {
    const normalized = hex.replace("#", "");
    if (normalized.length !== 6) {
      return { r: 255, g: 255, b: 255 };
    }
    return {
      r: parseInt(normalized.slice(0, 2), 16),
      g: parseInt(normalized.slice(2, 4), 16),
      b: parseInt(normalized.slice(4, 6), 16)
    };
  }

  function drawGrid(canvasWidth, canvasHeight) {
    const spacing = clamp(state.grid.size, 20, 260);
    const opacity = clamp(state.grid.opacity, 0, 100) / 100;
    const { r, g, b } = hexToRgb(state.grid.color);

    ctx.save();
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${opacity.toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0.5; x <= canvasWidth; x += spacing) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvasHeight);
    }
    for (let y = 0.5; y <= canvasHeight; y += spacing) {
      ctx.moveTo(0, y);
      ctx.lineTo(canvasWidth, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function hasActivePixelProcessing() {
    const f = state.filters;
    return f.grayscale || f.brightness !== 0 || f.contrast !== 0 || f.exposure !== 0;
  }

  function getFilterKey() {
    const f = state.filters;
    return [f.grayscale ? 1 : 0, f.brightness, f.contrast, f.exposure.toFixed(1)].join("|");
  }

  function invalidateImageFilterCache() {
    state.image.filterKey = "";
  }

  function queueFilterUpdate() {
    state.image.filterPending = true;
    if (state.filterDebounceId) {
      window.clearTimeout(state.filterDebounceId);
    }
    state.filterDebounceId = window.setTimeout(() => {
      state.image.filterPending = false;
      invalidateImageFilterCache();
      requestRender();
    }, 24);
    if (state.camera.active) requestRender();
  }

  function getImageSourceForRendering() {
    if (!state.image.loaded) return null;
    if (state.image.filterPending || !hasActivePixelProcessing()) {
      return state.image.sourceCanvas;
    }

    const key = getFilterKey();
    if (key !== state.image.filterKey) {
      rebuildImageFilter(key);
    }
    return state.image.filterKey === key
      ? state.image.filteredCanvas
      : state.image.sourceCanvas;
  }

  function rebuildImageFilter(filterKey) {
    if (!state.image.loaded || !hasActivePixelProcessing()) {
      state.image.filterKey = "";
      return;
    }

    const width = state.image.sourceCanvas.width;
    const height = state.image.sourceCanvas.height;
    const frame = imageSourceCtx.getImageData(0, 0, width, height);
    processPixelData(frame, state.filters);
    state.image.filteredCanvas.width = width;
    state.image.filteredCanvas.height = height;
    imageFilteredCtx.putImageData(frame, 0, 0);
    state.image.filterKey = filterKey;
  }

  function processPixelData(imageData, filters) {
    const data = imageData.data;
    const brightness = filters.brightness * 2.55;
    const contrastInput = filters.contrast * 2.55;
    const contrastFactor =
      (259 * (contrastInput + 255)) / (255 * (259 - contrastInput || 1));
    const exposureFactor = Math.pow(2, filters.exposure);

    for (let i = 0; i < data.length; i += 4) {
      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];

      r = contrastFactor * (r * exposureFactor + brightness - 128) + 128;
      g = contrastFactor * (g * exposureFactor + brightness - 128) + 128;
      b = contrastFactor * (b * exposureFactor + brightness - 128) + 128;

      if (filters.grayscale) {
        const gray = clampByte(0.299 * r + 0.587 * g + 0.114 * b);
        r = gray;
        g = gray;
        b = gray;
      }

      data[i] = clampByte(r);
      data[i + 1] = clampByte(g);
      data[i + 2] = clampByte(b);
      data[i + 3] = 255;
    }
  }

  async function loadImageFile(file) {
    if (!file) return;

    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      const sourceWidth = image.naturalWidth || image.width;
      const sourceHeight = image.naturalHeight || image.height;
      const maxDimension = 2200;
      const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));

      state.image.sourceCanvas.width = width;
      state.image.sourceCanvas.height = height;
      imageSourceCtx.clearRect(0, 0, width, height);
      imageSourceCtx.drawImage(image, 0, 0, width, height);

      state.image.loaded = true;
      state.image.filterPending = false;
      state.image.filterKey = "";
      state.image.x = 0;
      state.image.y = 0;
      state.image.scale = 1;
      state.image.rotation = 0;
      state.image.opacity = 0.7;
      state.image.locked = false;

      setAwaitingImage(false);
      setActiveTab("image");
      syncImageControls();
      requestRender();

      URL.revokeObjectURL(objectUrl);
    };

    image.onerror = () => {
      setStatus("Image failed to load.", true);
      URL.revokeObjectURL(objectUrl);
    };

    image.src = objectUrl;
  }

  function removeCurrentImage() {
    state.image.loaded = false;
    state.image.sourceCanvas.width = 1;
    state.image.sourceCanvas.height = 1;
    state.image.filteredCanvas.width = 1;
    state.image.filteredCanvas.height = 1;
    state.image.filterKey = "";
    state.image.filterPending = false;
    state.image.x = 0;
    state.image.y = 0;
    state.image.scale = 1;
    state.image.rotation = 0;
    state.image.opacity = 0.7;
    state.image.locked = false;
    setAwaitingImage(true);
    setActiveTab("image");
    syncImageControls();
    requestRender();
  }

  async function startCamera() {
    if (!window.isSecureContext) {
      setStatus("Camera needs HTTPS (or localhost).", true);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("Camera API unavailable in this context.", true);
      return;
    }
    if (state.camera.active) return;

    const attempts = [
      {
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      },
      { audio: false, video: true }
    ];

    let stream = null;
    let lastError = null;
    for (const constraints of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!stream) {
      const errorName = lastError && lastError.name ? lastError.name : "unknown";
      if (errorName === "NotAllowedError") {
        setStatus("Camera denied. Enable permission and reload.", true);
      } else if (errorName === "NotFoundError") {
        setStatus("No camera device found.", true);
      } else {
        setStatus("Could not start camera.", true);
      }
      return;
    }

    state.camera.stream = stream;
    state.camera.video.srcObject = stream;
    try {
      await state.camera.video.play();
    } catch (error) {
      // Some browsers start stream without resolved play promise.
    }

    state.camera.active = true;
    setStatus("Camera ready. Add picture to begin.");
    requestRender();
  }

  function stopCamera() {
    if (!state.camera.stream) return;
    state.camera.stream.getTracks().forEach((track) => track.stop());
    state.camera.video.srcObject = null;
    state.camera.stream = null;
    state.camera.active = false;
    requestRender();
  }

  async function requestWakeLock(silent = false) {
    if (!state.wakeLockRequested) return;
    if (!("wakeLock" in navigator)) {
      if (!silent) setStatus("Wake lock unsupported here.", true);
      return;
    }
    if (state.wakeLockSentinel) return;

    try {
      state.wakeLockSentinel = await navigator.wakeLock.request("screen");
      state.wakeLockSentinel.addEventListener("release", () => {
        state.wakeLockSentinel = null;
        if (document.visibilityState === "visible" && state.wakeLockRequested) {
          requestWakeLock(true);
        }
      });
    } catch (error) {
      if (!silent) setStatus("Could not keep screen awake.", true);
    }
  }

  async function releaseWakeLock() {
    if (!state.wakeLockSentinel) return;
    try {
      await state.wakeLockSentinel.release();
    } catch (error) {
      // Ignore release failures.
    }
    state.wakeLockSentinel = null;
  }

  async function requestPortraitOrientationLock(silent = false) {
    if (!screen.orientation || typeof screen.orientation.lock !== "function") {
      return;
    }
    try {
      await screen.orientation.lock("portrait-primary");
    } catch (error) {
      // Some browsers only allow lock() in fullscreen. Keep app usable either way.
      if (!silent) setStatus("Could not lock orientation.", true);
    }
  }

  function applyLoadedProjectData(projectData) {
    if (!projectData) return;

    if (projectData.image) {
      state.image.x = clamp(Number(projectData.image.x) || 0, -300, 300);
      state.image.y = clamp(Number(projectData.image.y) || 0, -300, 300);
      state.image.scale = clamp(Number(projectData.image.scale) || 1, 0.1, 8);
      state.image.rotation = normalizeAngle(Number(projectData.image.rotation) || 0);
      state.image.opacity = clamp(Number(projectData.image.opacity) || 0.7, 0, 1);
      state.image.locked =
        projectData.image.locked === undefined ? false : Boolean(projectData.image.locked);
    }

    if (projectData.camera) {
      state.camera.x = clamp(Number(projectData.camera.x) || 0, -300, 300);
      state.camera.y = clamp(Number(projectData.camera.y) || 0, -300, 300);
      state.camera.scale = clamp(Number(projectData.camera.scale) || 1, 1, 8);
      state.camera.rotation = normalizeAngle(Number(projectData.camera.rotation) || 0);
      state.camera.opacity = clamp(Number(projectData.camera.opacity) || 1, 0, 1);
      state.camera.locked = Boolean(projectData.camera.locked);
    }

    if (projectData.filters) {
      state.filters.grayscale = Boolean(projectData.filters.grayscale);
      state.filters.brightness = clamp(Number(projectData.filters.brightness) || 0, -100, 100);
      state.filters.contrast = clamp(Number(projectData.filters.contrast) || 0, -100, 100);
      state.filters.exposure = clamp(Number(projectData.filters.exposure) || 0, -2, 2);
    }

    if (projectData.grid) {
      state.grid.enabled = Boolean(projectData.grid.enabled);
      state.grid.size = clamp(Number(projectData.grid.size) || 40, 20, 200);
      state.grid.opacity = clamp(Number(projectData.grid.opacity) || 30, 0, 100);
      state.grid.color =
        typeof projectData.grid.color === "string" && /^#[0-9a-fA-F]{6}$/.test(projectData.grid.color)
          ? projectData.grid.color
          : "#ffffff";
    }
  }

  function exportProjectData() {
    if (!state.image.loaded) return null;
    return {
      version: 1,
      imageDataUrl: state.image.sourceCanvas.toDataURL("image/jpeg", 0.92),
      image: {
        x: state.image.x,
        y: state.image.y,
        scale: state.image.scale,
        rotation: state.image.rotation,
        opacity: state.image.opacity,
        locked: state.image.locked
      },
      camera: {
        x: state.camera.x,
        y: state.camera.y,
        scale: state.camera.scale,
        rotation: state.camera.rotation,
        opacity: state.camera.opacity,
        locked: state.camera.locked
      },
      filters: {
        grayscale: state.filters.grayscale,
        brightness: state.filters.brightness,
        contrast: state.filters.contrast,
        exposure: state.filters.exposure
      },
      grid: {
        enabled: state.grid.enabled,
        size: state.grid.size,
        opacity: state.grid.opacity,
        color: state.grid.color
      }
    };
  }

  function createEmptyProjectStore() {
    return {
      version: 2,
      currentProjectId: "",
      projects: []
    };
  }

  function createProjectId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `project-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  }

  function normalizeProjectName(name, fallback) {
    const text = typeof name === "string" ? name.trim() : "";
    const clipped = text.slice(0, MAX_PROJECT_NAME_LENGTH);
    return clipped || fallback;
  }

  function isValidProjectData(projectData) {
    return Boolean(projectData && typeof projectData.imageDataUrl === "string");
  }

  function normalizeStoredProject(project, index) {
    if (!project || typeof project !== "object") return null;
    if (!isValidProjectData(project.data)) return null;

    const fallbackName = `Project ${index + 1}`;
    const rawUpdatedAt = Number(project.updatedAt);
    return {
      id: typeof project.id === "string" && project.id.trim() ? project.id.trim() : "",
      name: normalizeProjectName(project.name, fallbackName),
      updatedAt: Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : 0,
      data: project.data
    };
  }

  function parseProjectStore(raw) {
    if (!raw) return createEmptyProjectStore();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("invalid saved projects");
    }

    const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
    const normalized = [];
    const seenIds = new Set();
    projects.forEach((project, index) => {
      const normalizedProject = normalizeStoredProject(project, index);
      if (!normalizedProject) return;
      let id = normalizedProject.id;
      if (!id || seenIds.has(id)) {
        id = createProjectId();
      }
      normalizedProject.id = id;
      seenIds.add(id);
      normalized.push(normalizedProject);
    });
    normalized.sort((a, b) => b.updatedAt - a.updatedAt);

    const requestedCurrent =
      typeof parsed.currentProjectId === "string" ? parsed.currentProjectId : "";
    const currentProjectId = normalized.some((project) => project.id === requestedCurrent)
      ? requestedCurrent
      : normalized[0]
        ? normalized[0].id
        : "";

    return {
      version: 2,
      currentProjectId,
      projects: normalized
    };
  }

  function saveProjectStore(store) {
    try {
      localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(store));
      return true;
    } catch (error) {
      return false;
    }
  }

  function migrateLegacyProjectIfNeeded() {
    const legacyRaw = localStorage.getItem(LEGACY_PROJECT_STORAGE_KEY) || "";
    if (!legacyRaw) return null;

    const legacyProject = JSON.parse(legacyRaw);
    if (!isValidProjectData(legacyProject)) return null;

    const now = Date.now();
    const migratedId = createProjectId();
    const migratedStore = {
      version: 2,
      currentProjectId: migratedId,
      projects: [
        {
          id: migratedId,
          name: "Imported Project",
          updatedAt: now,
          data: legacyProject
        }
      ]
    };

    if (!saveProjectStore(migratedStore)) {
      throw new Error("migrate failed");
    }
    return migratedStore;
  }

  function readProjectStore() {
    try {
      const raw = localStorage.getItem(PROJECT_STORAGE_KEY) || "";
      if (!raw) {
        return migrateLegacyProjectIfNeeded() || createEmptyProjectStore();
      }

      const store = parseProjectStore(raw);
      saveProjectStore(store);
      return store;
    } catch (error) {
      return null;
    }
  }

  function formatProjectTimestamp(updatedAt) {
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return "";
    try {
      return new Date(updatedAt).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
    } catch (error) {
      return "";
    }
  }

  function getProjectById(store, projectId) {
    return store.projects.find((project) => project.id === projectId) || null;
  }

  function findProjectByName(store, name) {
    const lower = name.toLowerCase();
    return store.projects.find((project) => project.name.toLowerCase() === lower) || null;
  }

  function buildDefaultProjectName(store) {
    let index = Math.max(1, store.projects.length + 1);
    let candidate = `Project ${index}`;
    while (findProjectByName(store, candidate)) {
      index += 1;
      candidate = `Project ${index}`;
    }
    return candidate;
  }

  function syncProjectControls(preferredProjectId = "", updateNameField = false) {
    const store = readProjectStore();
    if (!store) {
      elements.projectSelect.innerHTML = "";
      elements.projectSelect.disabled = true;
      elements.loadProjectButton.disabled = true;
      elements.deleteProjectButton.disabled = true;
      elements.startProjectSelect.innerHTML = "";
      const startUnavailable = document.createElement("option");
      startUnavailable.value = "";
      startUnavailable.textContent = "Saved projects unavailable";
      elements.startProjectSelect.appendChild(startUnavailable);
      elements.startProjectSelect.disabled = true;
      return null;
    }

    let selectedProjectId = preferredProjectId || store.currentProjectId;
    if (!getProjectById(store, selectedProjectId)) {
      selectedProjectId = store.projects[0] ? store.projects[0].id : "";
    }

    elements.projectSelect.innerHTML = "";
    elements.startProjectSelect.innerHTML = "";
    if (!store.projects.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No saved projects";
      elements.projectSelect.appendChild(option);
      elements.projectSelect.disabled = true;
      elements.loadProjectButton.disabled = true;
      elements.deleteProjectButton.disabled = true;
      const startOption = document.createElement("option");
      startOption.value = "";
      startOption.textContent = "No saved projects";
      elements.startProjectSelect.appendChild(startOption);
      elements.startProjectSelect.disabled = true;
      if (updateNameField) {
        elements.projectNameInput.value = "";
      }
      return {
        store,
        selectedProjectId: ""
      };
    }

    const startPlaceholder = document.createElement("option");
    startPlaceholder.value = "";
    startPlaceholder.textContent = "Choose saved project";
    elements.startProjectSelect.appendChild(startPlaceholder);

    store.projects.forEach((project) => {
      const option = document.createElement("option");
      option.value = project.id;
      const timestamp = formatProjectTimestamp(project.updatedAt);
      option.textContent = timestamp ? `${project.name} · ${timestamp}` : project.name;
      elements.projectSelect.appendChild(option);

      const startOption = document.createElement("option");
      startOption.value = project.id;
      startOption.textContent = project.name;
      elements.startProjectSelect.appendChild(startOption);
    });

    elements.projectSelect.disabled = false;
    elements.projectSelect.value = selectedProjectId;
    elements.loadProjectButton.disabled = false;
    elements.deleteProjectButton.disabled = false;
    elements.startProjectSelect.disabled = false;
    elements.startProjectSelect.value = "";

    if (updateNameField) {
      const selectedProject = getProjectById(store, selectedProjectId);
      elements.projectNameInput.value = selectedProject ? selectedProject.name : "";
    }

    return {
      store,
      selectedProjectId
    };
  }

  function hasSavedProject() {
    const store = readProjectStore();
    return Boolean(store && store.projects.length);
  }

  function saveProjectToStorage() {
    const projectData = exportProjectData();
    if (!projectData) {
      setStatus("Add an image before saving project.", true);
      return;
    }

    const syncResult = syncProjectControls("", false);
    if (!syncResult) {
      setStatus("Saved projects unavailable in this browser.", true);
      return;
    }

    const { store, selectedProjectId } = syncResult;
    const selectedProject = getProjectById(store, selectedProjectId);
    const typedName = normalizeProjectName(elements.projectNameInput.value, "");
    const now = Date.now();

    let targetProject = null;
    let created = false;
    if (!typedName) {
      if (selectedProject) {
        targetProject = selectedProject;
      } else {
        targetProject = {
          id: createProjectId(),
          name: buildDefaultProjectName(store),
          updatedAt: now,
          data: projectData
        };
        store.projects.push(targetProject);
        created = true;
      }
    } else if (selectedProject && selectedProject.name.toLowerCase() === typedName.toLowerCase()) {
      targetProject = selectedProject;
    } else {
      const namedProject = findProjectByName(store, typedName);
      if (namedProject) {
        const shouldOverwrite = window.confirm(`Overwrite "${namedProject.name}"?`);
        if (!shouldOverwrite) {
          setStatus("Save canceled.");
          return;
        }
        targetProject = namedProject;
      } else {
        targetProject = {
          id: createProjectId(),
          name: typedName,
          updatedAt: now,
          data: projectData
        };
        store.projects.push(targetProject);
        created = true;
      }
    }

    targetProject.name = typedName || targetProject.name;
    targetProject.updatedAt = now;
    targetProject.data = projectData;
    store.currentProjectId = targetProject.id;
    store.projects.sort((a, b) => b.updatedAt - a.updatedAt);

    if (!saveProjectStore(store)) {
      setStatus("Could not save project on this device.", true);
      return;
    }

    syncProjectControls(targetProject.id, true);
    setStatus(created ? `Saved "${targetProject.name}".` : `Updated "${targetProject.name}".`);
  }

  async function restoreImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const sourceWidth = image.naturalWidth || image.width;
        const sourceHeight = image.naturalHeight || image.height;
        const maxDimension = 2200;
        const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));

        state.image.sourceCanvas.width = width;
        state.image.sourceCanvas.height = height;
        imageSourceCtx.clearRect(0, 0, width, height);
        imageSourceCtx.drawImage(image, 0, 0, width, height);

        state.image.loaded = true;
        state.image.filterPending = false;
        state.image.filterKey = "";
        resolve();
      };
      image.onerror = () => reject(new Error("invalid image data"));
      image.src = dataUrl;
    });
  }

  async function loadProjectFromStorage(projectId = "") {
    const syncResult = syncProjectControls(projectId, false);
    if (!syncResult) {
      setStatus("Saved projects unavailable in this browser.", true);
      return false;
    }

    const { store, selectedProjectId } = syncResult;
    if (!selectedProjectId) {
      setStatus("No saved project found.", true);
      return false;
    }

    const project = getProjectById(store, selectedProjectId);
    if (!project || !isValidProjectData(project.data)) {
      setStatus("Saved project is invalid.", true);
      return false;
    }

    try {
      await restoreImageFromDataUrl(project.data.imageDataUrl);
      applyLoadedProjectData(project.data);

      setAwaitingImage(false);
      setActiveTab("image");
      syncImageControls();
      syncCameraControls();
      syncEditControls();
      syncGridControls();
      queueFilterUpdate();
      requestRender();

      store.currentProjectId = project.id;
      if (!saveProjectStore(store)) {
        setStatus("Project loaded, but could not update saved selection.", true);
      } else {
        setStatus(`Loaded "${project.name}".`);
      }
      syncProjectControls(project.id, true);
      return true;
    } catch (error) {
      setStatus("Saved project is invalid.", true);
      return false;
    }
  }

  function deleteProjectFromStorage() {
    const syncResult = syncProjectControls("", false);
    if (!syncResult) {
      setStatus("Saved projects unavailable in this browser.", true);
      return;
    }

    const { store, selectedProjectId } = syncResult;
    if (!selectedProjectId) {
      setStatus("No saved project selected.", true);
      return;
    }

    const targetProject = getProjectById(store, selectedProjectId);
    if (!targetProject) {
      setStatus("No saved project selected.", true);
      return;
    }

    const shouldDelete = window.confirm(`Delete "${targetProject.name}"?`);
    if (!shouldDelete) return;

    store.projects = store.projects.filter((project) => project.id !== targetProject.id);
    if (!store.projects.some((project) => project.id === store.currentProjectId)) {
      store.currentProjectId = store.projects[0] ? store.projects[0].id : "";
    }

    if (!saveProjectStore(store)) {
      setStatus("Could not delete project on this device.", true);
      return;
    }

    syncProjectControls(store.currentProjectId, true);
    setStatus(`Deleted "${targetProject.name}".`);
  }

  async function chooseImageOrProjectFromStart() {
    const selectedProjectId = elements.startProjectSelect.value;
    if (selectedProjectId) {
      await loadProjectFromStorage(selectedProjectId);
      return;
    }
    elements.imageInput.click();
  }

  function startGestureFromPointers(layerName) {
    const pointers = Array.from(state.pointers.values());
    if (!pointers.length) {
      state.gesture = null;
      return;
    }

    const layer = layerByName(layerName);
    if (pointers.length === 1) {
      const point = pointers[0];
      state.gesture = {
        layerName,
        mode: "pan",
        startX: point.x,
        startY: point.y,
        initialX: layer.x,
        initialY: layer.y
      };
      return;
    }

    const [a, b] = pointers;
    state.gesture = {
      layerName,
      mode: "transform",
      startCenter: pointerCenter(a, b),
      startDistance: pointerDistance(a, b),
      startAngle: pointerAngle(a, b),
      initialX: layer.x,
      initialY: layer.y,
      initialScale: layer.scale,
      initialRotation: layer.rotation
    };
  }

  function updateGesture() {
    if (!state.gesture) return;
    const layer = layerByName(state.gesture.layerName);
    if (layer.locked) return;

    const pointers = Array.from(state.pointers.values());
    if (!pointers.length) return;

    if (pointers.length === 1 && state.gesture.mode === "pan") {
      const point = pointers[0];
      layer.x = clamp(
        state.gesture.initialX + ((point.x - state.gesture.startX) / state.viewport.width) * 100,
        -300,
        300
      );
      layer.y = clamp(
        state.gesture.initialY + ((point.y - state.gesture.startY) / state.viewport.height) * 100,
        -300,
        300
      );
      requestRender();
      if (state.gesture.layerName === "camera") {
        syncCameraControls();
      } else {
        syncImageControls();
      }
      return;
    }

    if (pointers.length >= 2) {
      if (state.gesture.mode !== "transform") {
        startGestureFromPointers(state.gesture.layerName);
        return;
      }

      const [a, b] = pointers;
      const center = pointerCenter(a, b);
      const distance = pointerDistance(a, b);
      const angle = pointerAngle(a, b);

      const moveX = ((center.x - state.gesture.startCenter.x) / state.viewport.width) * 100;
      const moveY = ((center.y - state.gesture.startCenter.y) / state.viewport.height) * 100;
      const scaleRatio = distance / Math.max(1, state.gesture.startDistance);
      const rotation = angleDelta(angle, state.gesture.startAngle);
      const minScale = state.gesture.layerName === "camera" ? 1 : 0.1;

      layer.x = clamp(state.gesture.initialX + moveX, -300, 300);
      layer.y = clamp(state.gesture.initialY + moveY, -300, 300);
      layer.scale = clamp(state.gesture.initialScale * scaleRatio, minScale, 8);
      layer.rotation = normalizeAngle(state.gesture.initialRotation + rotation);
      requestRender();
      if (state.gesture.layerName === "camera") {
        syncCameraControls();
      } else {
        syncImageControls();
      }
    }
  }

  function handleCanvasPointerDown(event) {
    if (state.awaitingImage) return;
    const layerName = getGestureLayerName();
    if (!isLayerDrawable(layerName)) return;
    if (layerByName(layerName).locked) return;

    state.pointers.set(event.pointerId, { id: event.pointerId, x: event.clientX, y: event.clientY });
    elements.canvas.setPointerCapture(event.pointerId);
    startGestureFromPointers(layerName);
    event.preventDefault();
  }

  function handleCanvasPointerMove(event) {
    if (!state.pointers.has(event.pointerId)) return;
    state.pointers.set(event.pointerId, { id: event.pointerId, x: event.clientX, y: event.clientY });
    updateGesture();
    event.preventDefault();
  }

  function handleCanvasPointerUp(event) {
    if (!state.pointers.has(event.pointerId)) return;
    state.pointers.delete(event.pointerId);

    if (elements.canvas.hasPointerCapture(event.pointerId)) {
      elements.canvas.releasePointerCapture(event.pointerId);
    }

    if (!state.pointers.size) {
      state.gesture = null;
      return;
    }

    if (state.gesture) {
      startGestureFromPointers(state.gesture.layerName);
    }
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch(() => {
        setStatus("Service worker registration failed.", true);
      });
    });
  }

  function installTouchGuards() {
    document.addEventListener(
      "touchstart",
      (event) => {
        const onCanvas = Boolean(event.target.closest("#traceCanvas"));
        if (event.touches.length > 1 && !onCanvas) {
          event.preventDefault();
        }
      },
      { passive: false }
    );

    document.addEventListener(
      "touchmove",
      (event) => {
        const onCanvas = Boolean(event.target.closest("#traceCanvas"));
        const onDrawer = Boolean(event.target.closest("#controlDrawer"));
        if (event.touches.length > 1 && !onCanvas) {
          event.preventDefault();
          return;
        }
        if (!onCanvas && !onDrawer) {
          event.preventDefault();
        }
      },
      { passive: false }
    );

    let lastTouchEnd = 0;
    document.addEventListener(
      "touchend",
      (event) => {
        const now = Date.now();
        if (now - lastTouchEnd <= 320) {
          event.preventDefault();
        }
        lastTouchEnd = now;
      },
      { passive: false }
    );

    ["gesturestart", "gesturechange", "gestureend"].forEach((eventName) => {
      document.addEventListener(eventName, (event) => event.preventDefault());
    });
  }

  function bindEvents() {
    window.addEventListener("resize", resizeCanvas);
    window.addEventListener("orientationchange", () => {
      resizeCanvas();
      requestPortraitOrientationLock(true);
    });

    elements.startUploadButton.addEventListener("click", () => {
      chooseImageOrProjectFromStart();
    });

    elements.replaceImageButton.addEventListener("click", () => {
      elements.imageInput.click();
    });

    elements.removeImageButton.addEventListener("click", () => {
      removeCurrentImage();
    });

    elements.imageInput.addEventListener("change", (event) => {
      const [file] = event.target.files || [];
      loadImageFile(file);
      event.target.value = "";
    });

    elements.drawerToggle.addEventListener("click", () => {
      setDrawerOpen(!state.drawerOpen);
    });

    elements.tabButtons.forEach((button) => {
      button.addEventListener("click", () => {
        setActiveTab(button.dataset.tab);
      });
    });

    elements.imageLockButton.addEventListener("click", () => {
      state.image.locked = !state.image.locked;
      syncImageControls();
    });

    const updateImageOpacity = () => {
      state.image.opacity = clamp(parseFloat(elements.imageOpacityRange.value) || 0, 0, 1);
      syncImageControls();
      requestRender();
    };
    elements.imageOpacityRange.addEventListener("input", updateImageOpacity);
    elements.imageOpacityRange.addEventListener("change", updateImageOpacity);

    elements.resetCameraButton.addEventListener("click", () => {
      state.camera.x = 0;
      state.camera.y = 0;
      state.camera.scale = 1;
      state.camera.rotation = 0;
      state.camera.opacity = 1;
      syncCameraControls();
      requestRender();
    });

    elements.cameraLockButton.addEventListener("click", () => {
      state.camera.locked = !state.camera.locked;
      syncCameraControls();
    });

    elements.cameraOpacityRange.addEventListener("input", () => {
      if (state.camera.locked) return syncCameraControls();
      state.camera.opacity = parseFloat(elements.cameraOpacityRange.value);
      syncCameraControls();
      requestRender();
    });

    const updateCameraZoom = () => {
      if (state.camera.locked) return syncCameraControls();
      state.camera.scale = clamp(parseFloat(elements.cameraZoomRange.value) || 1, 1, 8);
      syncCameraControls();
      requestRender();
    };
    elements.cameraZoomRange.addEventListener("input", updateCameraZoom);
    elements.cameraZoomRange.addEventListener("change", updateCameraZoom);

    elements.grayscaleToggle.addEventListener("change", () => {
      state.filters.grayscale = elements.grayscaleToggle.checked;
      syncEditControls();
      queueFilterUpdate();
    });

    elements.resetEditButton.addEventListener("click", () => {
      state.filters.grayscale = false;
      state.filters.brightness = 0;
      state.filters.contrast = 0;
      state.filters.exposure = 0;
      syncEditControls();
      queueFilterUpdate();
    });

    elements.brightnessRange.addEventListener("input", () => {
      state.filters.brightness = parseInt(elements.brightnessRange.value, 10);
      syncEditControls();
      queueFilterUpdate();
    });

    elements.contrastRange.addEventListener("input", () => {
      state.filters.contrast = parseInt(elements.contrastRange.value, 10);
      syncEditControls();
      queueFilterUpdate();
    });

    elements.exposureRange.addEventListener("input", () => {
      state.filters.exposure = parseFloat(elements.exposureRange.value);
      syncEditControls();
      queueFilterUpdate();
    });

    elements.gridToggle.addEventListener("change", () => {
      state.grid.enabled = elements.gridToggle.checked;
      syncGridControls();
      requestRender();
    });

    elements.gridSizeRange.addEventListener("input", () => {
      state.grid.size = parseInt(elements.gridSizeRange.value, 10);
      syncGridControls();
      requestRender();
    });

    elements.gridOpacityRange.addEventListener("input", () => {
      state.grid.opacity = parseInt(elements.gridOpacityRange.value, 10);
      syncGridControls();
      requestRender();
    });

    elements.gridColorInput.addEventListener("input", () => {
      state.grid.color = elements.gridColorInput.value;
      syncGridControls();
      requestRender();
    });

    elements.projectSelect.addEventListener("change", () => {
      syncProjectControls(elements.projectSelect.value, true);
    });

    elements.projectNameInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      saveProjectToStorage();
    });

    elements.saveProjectButton.addEventListener("click", () => {
      saveProjectToStorage();
    });

    elements.loadProjectButton.addEventListener("click", async () => {
      await loadProjectFromStorage(elements.projectSelect.value);
    });

    elements.deleteProjectButton.addEventListener("click", () => {
      deleteProjectFromStorage();
    });

    elements.canvas.addEventListener("pointerdown", handleCanvasPointerDown);
    elements.canvas.addEventListener("pointermove", handleCanvasPointerMove);
    elements.canvas.addEventListener("pointerup", handleCanvasPointerUp);
    elements.canvas.addEventListener("pointercancel", handleCanvasPointerUp);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        requestWakeLock(true);
        requestPortraitOrientationLock(true);
        if (!state.camera.active) {
          startCamera();
        }
      }
    });

    window.addEventListener("pagehide", () => {
      stopCamera();
      releaseWakeLock();
    });
  }

  async function init() {
    bindEvents();
    installTouchGuards();
    resizeCanvas();
    setActiveTab("image");
    setAwaitingImage(true);
    syncImageControls();
    syncCameraControls();
    syncEditControls();
    syncGridControls();
    syncProjectControls("", false);
    setStatus("Starting camera...");
    registerServiceWorker();

    await requestWakeLock(true);
    await requestPortraitOrientationLock(true);
    await startCamera();
    requestRender();
  }

  init();
})();
