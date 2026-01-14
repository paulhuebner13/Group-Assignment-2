(function () {
  const SEVERITY_ORDER = ["Slight", "Serious", "Fatal"];
  const parseDate = d3.timeParse("%d/%m/%Y"); // like heatmap

  const UI = { text: "#ffffff", axis: "#ffffff" };
  const COLORS = { Slight: "#efeb2c", Serious: "#ff9800", Fatal: "#e41a1c" };
  function parseHour(s) {
    if (!s) return null;
    const m = String(s).trim().match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const h = Number(m[1]);
    return Number.isFinite(h) && h >= 0 && h <= 23 ? h : null;
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
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
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

  function normalizeSeverity(sev) {
    if (!sev) return null;
    let s = String(sev).trim();
    if (s === "Fetal") s = "Fatal";
    return s;
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
    container.appendChild(t);
    return t;
  }

  //Module
  let el = null;
  let svg = null;
  let g = null;

  const margin = { top: 6, right: 140, bottom: 70, left: 84 };
  let width = 0;
  let height = 0;

  let preparedRows = [];
  let tooltip = null;

  let lastState = { mode: "ALL", monthIndex: 0, severityFilter: { Fatal: true, Serious: true, Slight: true } };
  let roadSurfaceFilter = "All";
  let roadTypeFilter = "All";
  let roadSurfaceSelect = null;
  let roadTypeSelect = null;

  let resizeObserver = null;

  //Data preperation
  function prepareRows(rawRows) {
    const out = [];
    for (const r of rawRows) {
      const d = parseDate(r["Accident Date"]);
      const h = parseHour(r["Time"]);
      const sev = normalizeSeverity(r["Accident_Severity"]);
      if (!d || h === null || !sev) continue;
      const surface = normalizeFilterValue(r["Road_Surface_Conditions"]);
      const roadType = normalizeFilterValue(r["Road_Type"]);

      out.push({
        monthIndex: d.getMonth(), // 0..11
        hour: h,                  // 0..23
        severity: sev,
        roadSurface: surface,
        roadType
      });
    }
    return out;
  }

  // Layout
  function computeSize() {
    // Use the actual slot size (no forced big minimums)
    const rect = el.getBoundingClientRect();

    const fullW = Math.max(300, Math.floor(rect.width));
    const fullH = Math.max(260, Math.floor(rect.height));

    width = fullW - margin.left - margin.right;
    height = fullH - margin.top - margin.bottom;

    svg.attr("width", fullW).attr("height", fullH);
    g.attr("transform", `translate(${margin.left},${margin.top})`);
    g.select(".x-axis").attr("transform", `translate(0,${height})`);
    g.select(".x-label")
      .attr("x", width / 2)
      .attr("y", height + 34);

    g.select(".y-label")
      .attr("x", -height / 2)
      .attr("y", -42);

    g.select(".legend").attr("transform", `translate(${width + 16}, 6)`);
  }

  //Aggregation
  function aggregate(rows, state) {
    const sevFilter = state?.severityFilter || { Fatal: true, Serious: true, Slight: true };

    const filtered = rows.filter(r => {
      if (!sevFilter[r.severity]) return false;
      if (roadSurfaceFilter !== "All" && r.roadSurface !== roadSurfaceFilter) return false;
      if (roadTypeFilter !== "All" && r.roadType !== roadTypeFilter) return false;

      if (state?.mode === "MONTH") {
        return r.monthIndex === state.monthIndex;
      }
      return true; // ALL
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

  //Rendering
  function init({ slotSelector, preparedRows: rows }) {
    el = document.querySelector(slotSelector);
    if (!el) throw new Error("barchartModule: slot not found: " + slotSelector);

    preparedRows = rows || [];

    roadSurfaceSelect = document.getElementById("roadSurfaceFilter");
    roadTypeSelect = document.getElementById("roadTypeFilter");

    if (roadSurfaceSelect) {
      populateFilterSelect(
        roadSurfaceSelect,
        buildFilterOptions(preparedRows, "roadSurface"),
        "All surfaces"
      );
      roadSurfaceSelect.addEventListener("change", () => {
        roadSurfaceFilter = roadSurfaceSelect.value;
        update(lastState);
      });
    }

    if (roadTypeSelect) {
      populateFilterSelect(
        roadTypeSelect,
        buildFilterOptions(preparedRows, "roadType"),
        "All road types"
      );
      roadTypeSelect.addEventListener("change", () => {
        roadTypeFilter = roadTypeSelect.value;
        update(lastState);
      });
    }

    clearSlot(el);
    el.style.position = "relative";

    tooltip = ensureTooltip(el);

    svg = d3.select(el).append("svg");
    g = svg.append("g");

    g.append("g").attr("class", "x-axis");
    g.append("g").attr("class", "y-axis");
    g.append("g").attr("class", "layers");
    g.append("g").attr("class", "legend");
    g.append("text")
      .attr("class", "x-label")
      .attr("text-anchor", "middle")
      .style("font-size", "12px")
      .attr("fill", UI.text)
      .text("Hour of the Day");

    g.append("text")
      .attr("class", "y-label")
      .attr("transform", "rotate(-90)")
      .attr("text-anchor", "middle")
      .style("font-size", "12px")
      .attr("fill", UI.text)
      .text("Number of Accidents");

    computeSize();

    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = new ResizeObserver(() => {
      computeSize();
      update(lastState);
    });
    resizeObserver.observe(el);

    return { update };
  }

  function update(state) {
    if (!g) return;
    lastState = state || lastState;

    computeSize();

    const { byHour, severities } = aggregate(preparedRows, lastState);

    const x = d3.scaleBand()
      .domain(d3.range(24))
      .range([0, width])
      .padding(0.2);

    const maxTotal = d3.max(byHour, d => severities.reduce((sum, s) => sum + (d[s] || 0), 0)) || 0;

    const y = d3.scaleLinear()
      .domain([0, maxTotal])
      .nice()
      .range([height, 0]);

    const color = d3.scaleOrdinal()
      .domain(severities)
      .range(severities.map(s => COLORS[s] || "#999"));

    const stacked = d3.stack().keys(severities)(byHour);
    const layerSel = g.select(".layers")
      .selectAll("g.layer")
      .data(stacked, d => d.key);

    layerSel.exit().remove();

    const layerEnter = layerSel.enter()
      .append("g")
      .attr("class", "layer");

    const layers = layerEnter.merge(layerSel)
      .attr("fill", d => color(d.key));

    // rect join
    const rectSel = layers.selectAll("rect")
      .data(d => d, d => d.data.hour);

    rectSel.exit().remove();

    const rectEnter = rectSel.enter()
      .append("rect")
      .attr("x", d => x(d.data.hour))
      .attr("width", x.bandwidth())
      .attr("y", height)
      .attr("height", 0);

    rectEnter.merge(rectSel)
      .on("mousemove", (event, d) => {
        const hour = d.data.hour;
        const total = severities.reduce((sum, s) => sum + (d.data[s] || 0), 0);
        const details = severities.map(s => `${s}: ${d.data[s] || 0}`).join("<br>");

        tooltip.innerHTML =
          `<strong>Hour:</strong> ${hour}:00<br>` +
          `<strong>Total:</strong> ${total}<br><br>` +
          details;

        tooltip.style.opacity = "1";
        tooltip.style.left = (event.offsetX + 14) + "px";
        tooltip.style.top = (event.offsetY + 14) + "px";
      })
      .on("mouseleave", () => {
        tooltip.style.opacity = "0";
      })
      .transition()
      .duration(300)
      .attr("x", d => x(d.data.hour))
      .attr("width", x.bandwidth())
      .attr("y", d => y(d[1]))
      .attr("height", d => y(d[0]) - y(d[1]));

    // axes
    g.select(".x-axis")
      .attr("transform", `translate(0,${height})`)
      .call(d3.axisBottom(x).tickFormat(d => `${d}:00`).tickValues(d3.range(0, 24, 2)));

    g.select(".y-axis")
      .call(d3.axisLeft(y));

    styleAxisWhite(g.select(".x-axis"));
    styleAxisWhite(g.select(".y-axis"));

    // legenda
    const legend = g.select(".legend")
      .attr("transform", `translate(${width + 16}, 6)`);

    const items = legend.selectAll("g.item").data(severities, d => d);
    items.exit().remove();

    const itemsEnter = items.enter()
      .append("g")
      .attr("class", "item");

    itemsEnter.append("rect")
      .attr("width", 14)
      .attr("height", 14)
      .attr("rx", 2)
      .attr("ry", 2);

    itemsEnter.append("text")
      .attr("x", 20)
      .attr("y", 11)
      .style("font-size", "12px")
      .attr("fill", UI.text);

    const merged = itemsEnter.merge(items)
      .attr("transform", (d, i) => `translate(0, ${i * 22})`);

    merged.select("rect").attr("fill", d => color(d));
    merged.select("text").attr("fill", UI.text).text(d => d);
  }
  window.barchartModule = { prepareRows, init };
})();


