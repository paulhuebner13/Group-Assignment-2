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
const mapViewBtn = document.getElementById("mapViewBtn");
const severityToggleBtn = document.getElementById("severityToggleBtn");
const severityMenu = document.getElementById("severityMenu");
const severityChecks = Array.from(document.querySelectorAll("[data-sev-check]"));

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
  fullscreen: null,
  mapView: "DOTS",  // DOTS or PIES
  severityFilter: {
    Fatal: true,
    Serious: true,
    Slight: true
  }
};

// ---- Module instances ----
let heatmapInstance = null;
let preparedRows = [];
let mapInstance = null;   
let mapPreparedRows = [];
let barchartInstance = null;   
let barchartPreparedRows = []; 

// Configure paths here (only here!)
const CONFIG = {
  d3Url: "https://d3js.org/d3.v7.min.js",
  dataCsv: "data/Road Accident Data.csv",
  modules: {
    heatmap: "js/heatmap.js",
    map: "js/uk_map.js",
    barchart: "js/barchart.js"
  }
};

function applyUIState() {
  allYearBtn.setAttribute("aria-pressed", state.mode === "ALL" ? "true" : "false");

  if (mapViewBtn) {
    mapViewBtn.textContent = (state.mapView === "DOTS") ? "View: Points" : "View: Pie Charts";
    mapViewBtn.setAttribute("aria-pressed", state.mapView === "PIES" ? "true" : "false");
  }
  if (severityToggleBtn) {
    const active = Object.entries(state.severityFilter || {}).filter(([, on]) => on).map(([k]) => k);
    const label = (active.length === 3) ? "Severity: All"
      : (active.length === 0) ? "Severity: None"
        : "Severity: " + active.join(", ");
    severityToggleBtn.textContent = label;
    severityToggleBtn.setAttribute("aria-expanded", severityMenu && severityMenu.style.display === "flex" ? "true" : "false");
  }
  severityChecks.forEach(chk => {
    const sev = chk.dataset.sevCheck;
    chk.checked = !!state.severityFilter[sev];
  });

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
  if (barchartInstance) barchartInstance.update(state);
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

    // make state accessible for resize() (quick fix)
    window.__APP_STATE__ = state;

    // wait until CSS layout applied, then resize charts that need it
    requestAnimationFrame(() => {
      if (heatmapInstance && heatmapInstance.resize) heatmapInstance.resize();
      if (mapInstance && mapInstance.resize) mapInstance.resize();
      if (barchartInstance && barchartInstance.resize) barchartInstance.resize();
      updateVisuals();
    });
  });
});


if (mapViewBtn) {
  mapViewBtn.addEventListener("click", () => {
    state.mapView = (state.mapView === "DOTS") ? "PIES" : "DOTS";
    applyUIState();
    updateVisuals();
  });
}
if (severityToggleBtn) {
  const closeMenu = () => {
    if (severityMenu) severityMenu.style.display = "none";
    severityToggleBtn.setAttribute("aria-expanded", "false");
  };

  severityToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!severityMenu) return;
    const isOpen = severityMenu.style.display === "flex";
    severityMenu.style.display = isOpen ? "none" : "flex";
    severityToggleBtn.setAttribute("aria-expanded", isOpen ? "false" : "true");
  });

  severityChecks.forEach(chk => {
    chk.addEventListener("change", () => {
      const sev = chk.dataset.sevCheck;
      state.severityFilter[sev] = chk.checked;
      applyUIState();
      updateVisuals();
    });
  });

  document.addEventListener("click", (e) => {
    if (!severityMenu || !severityToggleBtn) return;
    const within = severityMenu.contains(e.target) || severityToggleBtn.contains(e.target);
    if (!within) closeMenu();
  });
}

(async function main() {
  // 1) Load D3 once
  await loadScript(CONFIG.d3Url);

  // 2) Load heatmap module
  await loadScript(CONFIG.modules.heatmap);
  await loadScript(CONFIG.modules.map);
  await loadScript(CONFIG.modules.barchart);

  // 3) Load data with d3.csv (now available)
  const raw = await d3.csv(CONFIG.dataCsv);

  // 4) Prepare rows in module
  preparedRows = window.HeatmapModule.prepareRows(raw);
  mapPreparedRows = window.UKMapModule.prepareRows(raw);
  barchartPreparedRows = window.barchartModule.prepareRows(raw);


  // 5) Create heatmap
  heatmapInstance = window.HeatmapModule.init({
    slotSelector: "#heatmapSlot",
    preparedRows
  });

  mapInstance = window.UKMapModule.init({
  slotSelector: "#mapSlot",
  preparedRows: mapPreparedRows
  });

  barchartInstance = window.barchartModule.init({
    slotSelector: "#thirdSlot",
    preparedRows: barchartPreparedRows
  });

  // 6) Apply fixed global scale once (stable scale)
  const fixedMax = window.HeatmapModule.computeFixedMax(preparedRows);
  heatmapInstance.setFixedScaleMax(fixedMax);

  applyUIState();
  requestAnimationFrame(() => {
  updateVisuals();
});
})().catch(err => console.error(err));
