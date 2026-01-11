(function () {
  const DEFAULT_SEVERITIES = ["Slight", "Serious", "Fatal"];

  // ---------- Helpers (robust column detection) ----------
  function pickFirstKey(obj, candidates) {
    const keys = Object.keys(obj || {});
    const lowerMap = new Map(keys.map(k => [k.toLowerCase(), k]));
    for (const c of candidates) {
      const hit = lowerMap.get(c.toLowerCase());
      if (hit) return hit;
    }
    return null;
  }

  function parseHourFromTimeStr(t) {
    if (!t) return NaN;
    const s = String(t).trim();
    // Accept "HH:MM", "H:MM", "HH:MM:SS"
    const m = s.match(/^(\d{1,2})\s*:\s*\d{1,2}/);
    if (!m) return NaN;
    const h = Number(m[1]);
    return Number.isFinite(h) ? h : NaN;
  }

  function parseMonthIndex(value) {
    if (!value) return null;
    const s = String(value).trim();

    // Try native Date parse 
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.getMonth();
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (m) {
      const mm = Number(m[2]);
      if (mm >= 1 && mm <= 12) return mm - 1;
    }
    return null;
  }

  //Module internal state
  let el = null;
  let svg = null;
  let g = null;

  let width = 0;
  let height = 0;
  let margin = { top: 18, right: 140, bottom: 42, left: 56 };

  let x = null;
  let y = null;
  let color = null;

  let prepared = [];
  let severities = DEFAULT_SEVERITIES.slice();

  let tooltip = null;

  function clearSlot(slot) {
    while (slot.firstChild) slot.removeChild(slot.firstChild);
  }

  function ensureTooltip(slot) {
    const t = document.createElement("div");
    t.className = "tooltip";
    t.style.opacity = "0";
    t.style.position = "absolute";
    t.style.left = "0px";
    t.style.top = "0px";
    slot.appendChild(t);
    return t;
  }

  // Data prep
  function prepareRows(raw) {
    if (!raw || raw.length === 0) return [];

    // detect columns on first row
    const sample = raw[0];

    const timeKey = pickFirstKey(sample, ["Time", "Accident_Time", "AccidentTime", "time"]);
    const sevKey = pickFirstKey(sample, ["Accident_Severity", "Severity", "accident_severity"]);
    const dateKey = pickFirstKey(sample, ["Date", "Accident_Date", "AccidentDate", "DateTime", "Datetime"]);

    return raw
      .map(r => {
        const hour = parseHourFromTimeStr(timeKey ? r[timeKey] : null);

        let sev = sevKey ? String(r[sevKey] || "").trim() : "";
        if (sev === "Fetal") sev = "Fatal"; // common typo you saw earlier
        if (!sev) return null;

        const monthIndex = dateKey ? parseMonthIndex(r[dateKey]) : null;

        return { hour, severity: sev, monthIndex };
      })
      .filter(d => d && !isNaN(d.hour));
  }

  // Aggregation
  function aggregate(rows, state) {
    // Apply shared filters:
    const sevFilter = state?.severityFilter || { Fatal: true, Serious: true, Slight: true };

    const filtered = rows.filter(d => {
      const sevOk = !!sevFilter[d.severity];
      if (!sevOk) return false;

      if (state?.mode === "MONTH") {
        // If monthIndex exists in data: filter; otherwise ignore month filter
        if (d.monthIndex === null) return true;
        return d.monthIndex === state.monthIndex;
      }
      return true; // ALL
    });

    // Ensure severity order consistent
    const present = new Set(filtered.map(d => d.severity));
    severities = DEFAULT_SEVERITIES.filter(s => present.has(s));

    const byHour = Array.from({ length: 24 }, (_, h) => {
      const obj = { hour: h };
      for (const s of severities) obj[s] = 0;
      return obj;
    });

    for (const d of filtered) {
      if (d.hour >= 0 && d.hour <= 23 && severities.includes(d.severity)) {
        byHour[d.hour][d.severity] += 1;
      }
    }
    return byHour;
  }

  // Rendering
  function init({ slotSelector, preparedRows }) {
    el = document.querySelector(slotSelector);
    if (!el) throw new Error("ThirdModule: slot not found: " + slotSelector);

    clearSlot(el);
    el.style.position = "relative"; // for tooltip positioning

    tooltip = ensureTooltip(el);

    // responsive-ish: read slot size
    const rect = el.getBoundingClientRect();
    const fullW = Math.max(600, rect.width || 700);
    const fullH = Math.max(360, rect.height || 420);

    width = fullW - margin.left - margin.right;
    height = fullH - margin.top - margin.bottom;

    prepared = preparedRows || [];

    svg = d3.select(el)
      .append("svg")
      .attr("width", fullW)
      .attr("height", fullH);

    g = svg.append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    // axes groups
    g.append("g").attr("class", "x-axis").attr("transform", `translate(0,${height})`);
    g.append("g").attr("class", "y-axis");

    // labels
    g.append("text")
      .attr("class", "x-label")
      .attr("x", width / 2)
      .attr("y", height + 34)
      .attr("text-anchor", "middle")
      .style("font-size", "12px")
      .text("Hour of the Day");

    g.append("text")
      .attr("class", "y-label")
      .attr("x", -height / 2)
      .attr("y", -42)
      .attr("transform", "rotate(-90)")
      .attr("text-anchor", "middle")
      .style("font-size", "12px")
      .text("Number of Accidents");

    // containers
    g.append("g").attr("class", "layers");
    g.append("g").attr("class", "legend").attr("transform", `translate(${width + 16}, 6)`);

    return {
      update: (state) => update(state)
    };
  }

  function update(state) {
    if (!g) return;

    const data = aggregate(prepared, state);

    // scales
    x = d3.scaleBand().domain(d3.range(24)).range([0, width]).padding(0.2);
    const maxTotal = d3.max(data, d => severities.reduce((sum, s) => sum + (d[s] || 0), 0)) || 0;
    y = d3.scaleLinear().domain([0, maxTotal]).nice().range([height, 0]);

    // colors: green / orange / red
    const sevColors = { Slight: "#4daf4a", Serious: "#ff9800", Fatal: "#e41a1c" };
    color = d3.scaleOrdinal().domain(severities).range(severities.map(s => sevColors[s] || "#999"));

    // stack
    const stacked = d3.stack().keys(severities)(data);

    // draw layers
    const layerSel = g.select(".layers")
      .selectAll("g.layer")
      .data(stacked, d => d.key);

    layerSel.exit().remove();

    const layerEnter = layerSel.enter()
      .append("g")
      .attr("class", "layer")
      .attr("fill", d => color(d.key));

    const layers = layerEnter.merge(layerSel)
      .attr("fill", d => color(d.key));

    // bars
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
        const detailLines = severities.map(s => `${s}: ${d.data[s] || 0}`).join("<br>");

        tooltip.innerHTML =
          `<strong>Hour:</strong> ${hour}:00<br>` +
          `<strong>Total:</strong> ${total}<br><br>` +
          detailLines;

        tooltip.style.opacity = "1";
        tooltip.style.left = (event.offsetX + 14) + "px";
        tooltip.style.top = (event.offsetY + 14) + "px";
      })
      .on("mouseleave", () => {
        tooltip.style.opacity = "0";
      })
      .transition()
      .duration(450)
      .attr("x", d => x(d.data.hour))
      .attr("width", x.bandwidth())
      .attr("y", d => y(d[1]))
      .attr("height", d => y(d[0]) - y(d[1]));

    // axes
    g.select(".x-axis")
      .transition().duration(250)
      .call(d3.axisBottom(x).tickFormat(d => `${d}:00`).tickValues(d3.range(0, 24, 2)));

    g.select(".y-axis")
      .transition().duration(250)
      .call(d3.axisLeft(y));

    // legend
    const legend = g.select(".legend");

    const item = legend.selectAll("g.item")
      .data(severities, d => d);

    item.exit().remove();

    const itemEnter = item.enter()
      .append("g")
      .attr("class", "item")
      .attr("transform", (d, i) => `translate(0, ${i * 22})`);

    itemEnter.append("rect")
      .attr("width", 14)
      .attr("height", 14)
      .attr("rx", 2)
      .attr("ry", 2);

    itemEnter.append("text")
      .attr("x", 20)
      .attr("y", 11)
      .style("font-size", "12px");

    const itemMerged = itemEnter.merge(item)
      .attr("transform", (d, i) => `translate(0, ${i * 22})`);

    itemMerged.select("rect").attr("fill", d => color(d));
    itemMerged.select("text").text(d => d);
  }

  // Expose
  window.ThirdModule = {
    prepareRows,
    init
  };
})();