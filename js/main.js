// main.js
// Loads dependencies (d3 + modules) dynamically so index.html stays unchanged.


function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load script: " + src));
    document.head.appendChild(s);
  });
}

// ---- UI elements (already in your HTML) ----
const allYearBtn = document.getElementById("allYearBtn");
const slider = document.getElementById("monthSlider");
const dashboard = document.getElementById("dashboard");

const monthLabelsWrap = document.getElementById("monthLabels");
const monthLabelEls = Array.from(monthLabelsWrap.querySelectorAll(".monthLabel"));

const panels = {
  map: document.getElementById("mapPanel"),
  heatmap: document.getElementById("heatmapPanel"),
  third: document.getElementById("thirdPanel")
};

const state = {
  mode: "ALL",      // ALL or MONTH
  monthIndex: 0,
  fullscreen: null
};

// ---- Module instances ----
let heatmapInstance = null;
let preparedRows = [];
let mapInstance = null;   
let mapPreparedRows = []; 

// Configure paths here (only here!)
const CONFIG = {
  d3Url: "https://d3js.org/d3.v7.min.js",
  dataCsv: "data/Road Accident Data.csv",
  modules: {
    heatmap: "js/heatmap.js",
    map: "js/uk_map.js" 
  }
};

function applyUIState() {
  allYearBtn.setAttribute("aria-pressed", state.mode === "ALL" ? "true" : "false");

  monthLabelEls.forEach((el, idx) => {
    const active = (state.mode === "MONTH" && idx === state.monthIndex);
    el.classList.toggle("active", active);
  });

  dashboard.classList.toggle("fullscreen", state.fullscreen !== null);

  Object.entries(panels).forEach(([key, el]) => {
    el.classList.toggle("isFullscreen", state.fullscreen === key);
  });

  document.querySelectorAll("[data-fs]").forEach(btn => {
    const id = btn.dataset.fs;
    btn.textContent = (state.fullscreen === id) ? "Exit fullscreen" : "Fullscreen";
  });
}

function updateVisuals() {
  if (heatmapInstance) heatmapInstance.update(state);
  if (mapInstance) mapInstance.update(state);
}

allYearBtn.addEventListener("click", () => {
  state.mode = "ALL";
  applyUIState();
  updateVisuals();
});

slider.addEventListener("input", () => {
  state.mode = "MONTH";
  state.monthIndex = Number(slider.value);
  applyUIState();
  updateVisuals();
});

monthLabelEls.forEach(el => {
  el.addEventListener("click", () => {
    state.mode = "MONTH";
    state.monthIndex = Number(el.dataset.month);
    slider.value = String(state.monthIndex);
    applyUIState();
    updateVisuals();
  });
});

document.querySelectorAll("[data-fs]").forEach(btn => {
  btn.addEventListener("click", () => {
    const id = btn.dataset.fs;
    state.fullscreen = (state.fullscreen === id) ? null : id;
    applyUIState();
    updateVisuals();
  });
});

(async function main() {
  // 1) Load D3 once
  await loadScript(CONFIG.d3Url);

  // 2) Load heatmap module
  await loadScript(CONFIG.modules.heatmap);
  await loadScript(CONFIG.modules.map);

  // 3) Load data with d3.csv (now available)
  const raw = await d3.csv(CONFIG.dataCsv);

  // 4) Prepare rows in module
  preparedRows = window.HeatmapModule.prepareRows(raw);
  mapPreparedRows = window.UKMapModule.prepareRows(raw);


  // 5) Create heatmap
  heatmapInstance = window.HeatmapModule.init({
    slotSelector: "#heatmapSlot",
    preparedRows
  });

  mapInstance = window.UKMapModule.init({
  slotSelector: "#mapSlot",
  preparedRows: mapPreparedRows
  });

  // 6) Apply fixed global scale once (stable scale)
  const fixedMax = window.HeatmapModule.computeFixedMax(preparedRows);
  heatmapInstance.setFixedScaleMax(fixedMax);

  applyUIState();
  requestAnimationFrame(() => {
  updateVisuals();
});
})().catch(err => console.error(err));
