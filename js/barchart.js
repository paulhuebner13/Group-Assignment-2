// js/barchart.js
// Stacked bar chart by hour with stable resizing and centering
// Exposes window.barchartModule = { prepareRows, init }.

(function () {
  const SEVERITY_ORDER = ["Slight", "Serious", "Fatal"];
  const parseDate = d3.timeParse("%d/%m/%Y");

  const UI = {
    text: "#ffffff",
    axis: "#ffffff",
    grid: "rgba(255,255,255,0.10)"
  };

  // Adjust colours
  const COLORS = {
    Slight: "#efeb2c",
    Serious: "#ff9800",
    Fatal: "#e41a1c"
  };

  function parseHour(s) {
    if (!s) return null;
    const m = String(s).trim().match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const h = Number(m[1]);
    return Number.isFinite(h) && h >= 0 && h <= 23 ? h : null;
  }

  function normalizeSeverity(sev) {
    if (!sev) return null;
    let s = String(sev).trim();
    if (s === "Fetal") s = "Fatal";
    return s;
  }

  function normalizeFilterValue(value) {
    const v = (value ?? "").toString().trim();
    return v.length ? v : "Unknown";
  }

  function buildFilterOptions(rows, key) {
    const counts = new Map();
    for (const row of rows) {
      const value = normalizeFilterValue(row[key]);
      if (value === "Unknown") continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  function populateFilterSelect(selectEl, items, allLabel) {
    if (!selectEl) return;
    selectEl.innerHTML = "";

    const allOpt = document.createElement("option");
    allOpt.value = "All";
    allOpt.textContent = allLabel;
    selectEl.appendChild(allOpt);

    items.forEach(([value]) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = value;
      selectEl.appendChild(opt);
    });
  }

  function styleAxisWhite(axisG) {
    axisG.selectAll("text").attr("fill", UI.text);
    axisG.selectAll(".domain").attr("stroke", UI.axis);
    axisG.selectAll(".tick line").attr("stroke", UI.axis);
  }

  function clearSlot(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function ensureTooltip(container) {
    const t = document.createElement("div");
    t.className = "tooltip";
    t.style.opacity = "0";
    t.style.position = "absolute";
    t.style.left = "0px";
    t.style.top = "0px";
    t.style.pointerEvents = "none";
    container.appendChild(t);
    return t;
  }

  function prepareRows(rawRows) {
    const out = [];
    for (const r of rawRows) {
      const d = parseDate(r["Accident Date"]);
      const h = parseHour(r["Time"]);
      const sev = normalizeSeverity(r["Accident_Severity"]);
      if (!d || h === null || !sev) continue;

      out.push({
  monthIndex: d.getMonth(),
  weekdayIndex: (d.getDay() + 6) % 7, // Mon=0 ... Sun=6
  hour: h,
  severity: sev,
  roadSurface: normalizeFilterValue(r["Road_Surface_Conditions"]),
  roadType: normalizeFilterValue(r["Road_Type"])
});

    }
    return out;
  }

  // Module state
  let el = null;
  let svg = null;
  let rootG = null;

  let gGrid = null;
  let gBars = null;
  let gXAxis = null;
  let gYAxis = null;
  let gLegend = null;

  let preparedRows = [];
  let tooltip = null;

  let lastState = {
    mode: "ALL",
    monthIndex: 0,
    severityFilter: { Fatal: true, Serious: true, Slight: true }
  };

  let roadSurfaceFilter = "All";
  let roadTypeFilter = "All";

  let roadSurfaceSelect = null;
  let roadTypeSelect = null;

  let width = 0;
  let height = 0;

  // Responsive margins: stable and centered
  const baseMargin = { top: 14, right: 18, bottom: 46, left: 56 };
  let margin = { ...baseMargin };

  // Resize scheduling
  let ro = null;
  let resizeQueued = false;
  let lastMeasured = { w: 0, h: 0 };

  function measure() {
  // clientWidth/Height are more reliable when parent is scaled via CSS transform
  const fullW = Math.max(260, Math.floor(el.clientWidth || 0));
  const fullH = Math.max(220, Math.floor(el.clientHeight || 0));

  // Keep margins reasonable on small heights
  const bottom = Math.max(40, Math.min(54, Math.floor(fullH * 0.22)));
  const left = Math.max(44, Math.min(70, Math.floor(fullW * 0.12)));

  margin = {
    top: baseMargin.top,
    right: baseMargin.right,   // keep small
    bottom,
    left
  };

  width = Math.max(10, fullW - margin.left - margin.right);
  height = Math.max(10, fullH - margin.top - margin.bottom);

  svg.attr("width", fullW).attr("height", fullH);
  rootG.attr("transform", `translate(${margin.left},${margin.top})`);
  gXAxis.attr("transform", `translate(0,${height})`);

  lastMeasured.w = fullW;
  lastMeasured.h = fullH;
}


  function scheduleResizeAndRender() {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      if (!el.clientWidth || !el.clientHeight) return;
      measure();
      render(lastState, true);
    });
  }

  function aggregate(rows, state) {
    const sevFilter = state?.severityFilter || { Fatal: true, Serious: true, Slight: true };

    const filtered = rows.filter(r => {
  if (!sevFilter[r.severity]) return false;
  if (roadSurfaceFilter !== "All" && r.roadSurface !== roadSurfaceFilter) return false;
  if (roadTypeFilter !== "All" && r.roadType !== roadTypeFilter) return false;

  if (state?.weekdayFilter !== null && state?.weekdayFilter !== undefined) {
    if (r.weekdayIndex !== state.weekdayFilter) return false;
  }

  if (state?.mode === "MONTH") return r.monthIndex === state.monthIndex;
  return true;
});


    const present = new Set(filtered.map(d => d.severity));
    const severities = SEVERITY_ORDER.filter(s => present.has(s));

    const byHour = Array.from({ length: 24 }, (_, hour) => {
      const o = { hour };
      for (const s of severities) o[s] = 0;
      return o;
    });

    for (const r of filtered) {
      if (r.hour >= 0 && r.hour <= 23 && severities.includes(r.severity)) {
        byHour[r.hour][r.severity] += 1;
      }
    }

    return { byHour, severities };
  }

  function tooltipMove(event) {
  const rect = el.getBoundingClientRect();

  const unscaledW = el.offsetWidth || rect.width || 1;
  const unscaledH = el.offsetHeight || rect.height || 1;

  const scaleX = rect.width / unscaledW;
  const scaleY = rect.height / unscaledH;

  // mouse position in unscaled coords
  const mouseX = (event.clientX - rect.left) / (scaleX || 1);
  const mouseY = (event.clientY - rect.top) / (scaleY || 1);

  const tipW = tooltip.offsetWidth || 0;
  const tipH = tooltip.offsetHeight || 0;

  const offset = 22;  // distance from cursor (increase if needed)
  const edgePad = 8;

  // Prefer right + down
  let left = mouseX + offset;
  let top = mouseY + offset;

  // Flip if near right edge
  if (left + tipW + edgePad > unscaledW) {
    left = mouseX - offset - tipW;
  }

  // Flip if near bottom edge
  if (top + tipH + edgePad > unscaledH) {
    top = mouseY - offset - tipH;
  }

  // Clamp
  left = Math.max(edgePad, Math.min(left, unscaledW - tipW - edgePad));
  top = Math.max(edgePad, Math.min(top, unscaledH - tipH - edgePad));

  tooltip.style.left = left + "px";
  tooltip.style.top = top + "px";
}


  function render(state, fromResize = false) {
    if (!rootG) return;

    lastState = state || lastState;

    const { byHour, severities } = aggregate(preparedRows, lastState);

    const safeSevs = severities.length ? severities : ["Slight"];

    const x = d3.scaleBand()
  .domain(d3.range(24))
  .range([0, width])
  .paddingInner(0.12)
  .paddingOuter(0.02);


    const maxTotal = d3.max(byHour, d => safeSevs.reduce((sum, s) => sum + (d[s] || 0), 0)) || 0;

    const y = d3.scaleLinear()
      .domain([0, Math.max(1, maxTotal)])
      .nice()
      .range([height, 0]);

    const color = d3.scaleOrdinal()
      .domain(safeSevs)
      .range(safeSevs.map(s => COLORS[s] || "#999"));

    // Gridlines (y)
    const yTicks = y.ticks(5);
    const gridSel = gGrid.selectAll("line.grid").data(yTicks, d => d);
    gridSel.exit().remove();
    gridSel.enter()
      .append("line")
      .attr("class", "grid")
      .merge(gridSel)
      .attr("x1", 0)
      .attr("x2", width)
      .attr("y1", d => y(d))
      .attr("y2", d => y(d))
      .attr("stroke", UI.grid)
      .attr("stroke-width", 1);

    const stacked = d3.stack().keys(safeSevs)(byHour);

    const layerSel = gBars.selectAll("g.layer").data(stacked, d => d.key);
    layerSel.exit().remove();

    const layerEnter = layerSel.enter().append("g").attr("class", "layer");
    const layers = layerEnter.merge(layerSel).attr("fill", d => color(d.key));

    const rectSel = layers.selectAll("rect")
      .data(d => d, d => d.data.hour);

    rectSel.exit().remove();

    const rectEnter = rectSel.enter()
      .append("rect")
      .attr("x", d => x(d.data.hour))
      .attr("width", x.bandwidth())
      .attr("y", height)
      .attr("height", 0);

    const allRects = rectEnter.merge(rectSel);

    allRects
      .on("mouseenter", (event, d) => {
        const hour = d.data.hour;
        const total = safeSevs.reduce((sum, s) => sum + (d.data[s] || 0), 0);
const tooltipOrder = ["Fatal", "Serious", "Slight"].filter(s => safeSevs.includes(s));
const details = tooltipOrder.map(s => `${s}: ${d.data[s] || 0}`).join("<br>");

        tooltip.innerHTML =
          `<strong>Hour:</strong> ${hour}:00<br>` +
          `<strong>Total:</strong> ${total}<br><br>` +
          details;

        tooltip.style.opacity = "1";
        tooltipMove(event);
      })
      .on("mousemove", (event) => tooltipMove(event))
      .on("mouseleave", () => {
        tooltip.style.opacity = "0";
      });

    if (fromResize) {
      allRects
        .attr("x", d => x(d.data.hour))
        .attr("width", x.bandwidth())
        .attr("y", d => y(d[1]))
        .attr("height", d => Math.max(0, y(d[0]) - y(d[1])));
    } else {
      allRects
        .transition()
        .duration(220)
        .attr("x", d => x(d.data.hour))
        .attr("width", x.bandwidth())
        .attr("y", d => y(d[1]))
        .attr("height", d => Math.max(0, y(d[0]) - y(d[1])));
    }

    const tickStep = (width < 520) ? 3 : 2;
    gXAxis
      .call(d3.axisBottom(x).tickValues(d3.range(0, 24, tickStep)).tickFormat(d => `${d}:00`));

    gYAxis
      .call(d3.axisLeft(y).ticks(5));

    styleAxisWhite(gXAxis);
    styleAxisWhite(gYAxis);

    rootG.select("text.x-label")
      .attr("x", width / 2)
      .attr("y", height + (margin.bottom - 14));

    rootG.select("text.y-label")
      .attr("x", -height / 2)
      .attr("y", -Math.max(44, margin.left - 12));

    // Legend inside plot so chart stays visually centered
    const legendPadding = 10;
const itemH = 18;

// Tight box width for legend
const legendBoxW = 92;
const legendX = Math.max(0, width - legendBoxW);
const legendY = 0;

gLegend.attr("transform", `translate(${legendX},${legendY})`);

    const items = gLegend.selectAll("g.item").data(safeSevs, d => d);
    items.exit().remove();

    const itemsEnter = items.enter().append("g").attr("class", "item");
    itemsEnter.append("rect")
      .attr("width", 12)
      .attr("height", 12)
      .attr("rx", 2)
      .attr("ry", 2);

    itemsEnter.append("text")
      .attr("x", 18)
      .attr("y", 10)
      .style("font-size", "12px")
      .attr("fill", UI.text);

    const merged = itemsEnter.merge(items)
      .attr("transform", (d, i) => `translate(${legendPadding}, ${legendPadding + i * itemH})`);

    merged.select("rect").attr("fill", d => color(d));
    merged.select("text").text(d => d);
  }

  function init({ slotSelector, preparedRows: rows }) {
    el = document.querySelector(slotSelector);
    if (!el) throw new Error("barchartModule: slot not found: " + slotSelector);

    preparedRows = rows || [];

    roadSurfaceSelect = document.getElementById("roadSurfaceFilter");
    roadTypeSelect = document.getElementById("roadTypeFilter");

    if (roadSurfaceSelect) {
      populateFilterSelect(roadSurfaceSelect, buildFilterOptions(preparedRows, "roadSurface"), "All surfaces");
      roadSurfaceSelect.addEventListener("change", () => {
        roadSurfaceFilter = roadSurfaceSelect.value;
        render(lastState, false);
      });
    }

    if (roadTypeSelect) {
      populateFilterSelect(roadTypeSelect, buildFilterOptions(preparedRows, "roadType"), "All road types");
      roadTypeSelect.addEventListener("change", () => {
        roadTypeFilter = roadTypeSelect.value;
        render(lastState, false);
      });
    }

    clearSlot(el);
    el.style.position = "relative";

    tooltip = ensureTooltip(el);

    svg = d3.select(el).append("svg");
    rootG = svg.append("g");

    gGrid = rootG.append("g").attr("class", "gridlines");
    gBars = rootG.append("g").attr("class", "bars");
    gXAxis = rootG.append("g").attr("class", "x-axis");
    gYAxis = rootG.append("g").attr("class", "y-axis");
    gLegend = rootG.append("g").attr("class", "legend");

    rootG.append("text")
      .attr("class", "x-label")
      .attr("text-anchor", "middle")
      .style("font-size", "12px")
      .attr("fill", UI.text)
      .text("Hour of the Day");

    rootG.append("text")
      .attr("class", "y-label")
      .attr("transform", "rotate(-90)")
      .attr("text-anchor", "middle")
      .style("font-size", "12px")
      .attr("fill", UI.text)
      .text("Number of Accidents");

    measure();
    render(lastState, true);

    if (ro) ro.disconnect();
    ro = new ResizeObserver(() => scheduleResizeAndRender());
    ro.observe(el);

    return {
      update(state) {
        render(state, false);
      },
      resize() {
        scheduleResizeAndRender();
      }
    };
  }

  window.barchartModule = { prepareRows, init };
})();
