(function () {
  const SEVERITY_ORDER = ["Slight", "Serious", "Fatal"];

  // Match heatmap date parsing approach
  const parseDate = d3.timeParse("%d/%m/%Y"); // same as heatmap.js :contentReference[oaicite:3]{index=3}

  // White styling
  const UI = { text: "#ffffff", axis: "#ffffff" };

  // ---------- Parsing helpers ----------
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

  function styleAxisWhite(axisG) {
    axisG.selectAll("text").attr("fill", UI.text);
    axisG.selectAll(".domain").attr("stroke", UI.axis);
    axisG.selectAll(".tick line").attr("stroke", UI.axis);
  }

  // ---------- Module state ----------
  let el = null, svg = null, g = null;
  let width = 0, height = 0;
  const margin = { top: 18, right: 140, bottom: 42, left: 56 };

  let preparedRows = [];
  let tooltip = null;

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

  // ---------- Public: prepareRows ----------
  function prepareRows(rawRows) {
    const out = [];

    let parsedDates = 0;

    for (const r of rawRows) {
      const d = parseDate(r["Accident Date"]); // same column as heatmap.js :contentReference[oaicite:4]{index=4}
      const h = parseHour(r["Time"]);          // same column as heatmap.js :contentReference[oaicite:5]{index=5}
      const sev = normalizeSeverity(r["Accident_Severity"]);

      if (!d || h === null || !sev) continue;

      parsedDates += 1;

      out.push({
        monthIndex: d.getMonth(), // 0..11
        hour: h,                  // 0..23
        severity: sev
      });
    }

    if (rawRows.length && parsedDates / rawRows.length < 0.2) {
      console.warn(
        "[barchart] Low date parse rate. Check 'Accident Date' format is DD/MM/YYYY."
      );
    }

    return out;
  }

  // ---------- Aggregation ----------
  function aggregate(rows) {
    // Build 24 hours always
    const base = Array.from({ length: 24 }, (_, hour) => {
      const o = { hour };
      for (const s of SEVERITY_ORDER) o[s] = 0;
      return o;
    });

    // Count
    for (const r of rows) {
      if (r.hour >= 0 && r.hour <= 23 && SEVERITY_ORDER.includes(r.severity)) {
        base[r.hour][r.severity] += 1;
      }
    }

    // Determine which severities actually present (optional)
    const present = new Set();
    for (const o of base) {
      for (const s of SEVERITY_ORDER) {
        if ((o[s] || 0) > 0) present.add(s);
      }
    }
    const severities = SEVERITY_ORDER.filter(s => present.has(s));
    return { byHour: base, severities };
  }

  // ---------- Public: init ----------
  function init({ slotSelector, preparedRows: rows }) {
    el = document.querySelector(slotSelector);
    if (!el) throw new Error("barchartModule: slot not found: " + slotSelector);

    preparedRows = rows || [];

    clearSlot(el);
    el.style.position = "relative";
    tooltip = ensureTooltip(el);

    const rect = el.getBoundingClientRect();
    const fullW = Math.max(600, rect.width || 700);
    const fullH = Math.max(360, rect.height || 420);

    width = fullW - margin.left - margin.right;
    height = fullH - margin.top - margin.bottom;

    svg = d3.select(el)
      .append("svg")
      .attr("width", fullW)
      .attr("height", fullH);

    g = svg.append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    g.append("g").attr("class", "x-axis").attr("transform", `translate(0,${height})`);
    g.append("g").attr("class", "y-axis");
    g.append("g").attr("class", "layers");
    g.append("g").attr("class", "legend").attr("transform", `translate(${width + 16}, 6)`);

    // labels
    g.append("text")
      .attr("x", width / 2)
      .attr("y", height + 34)
      .attr("text-anchor", "middle")
      .style("font-size", "12px")
      .attr("fill", UI.text)
      .text("Hour of the Day");

    g.append("text")
      .attr("x", -height / 2)
      .attr("y", -42)
      .attr("transform", "rotate(-90)")
      .attr("text-anchor", "middle")
      .style("font-size", "12px")
      .attr("fill", UI.text)
      .text("Number of Accidents");

    return { update };
  }

  // ---------- Public: update ----------
  function update(state) {
    if (!g) return;

    // Same logic as heatmap: filter rows based on state.mode/monthIndex :contentReference[oaicite:6]{index=6}
    const rows = (state && state.mode === "MONTH")
      ? preparedRows.filter(r => r.monthIndex === state.monthIndex)
      : preparedRows;

    const { byHour, severities } = aggregate(rows);

    // scales
    const x = d3.scaleBand()
      .domain(d3.range(24))
      .range([0, width])
      .padding(0.2);

    const maxTotal = d3.max(byHour, d => severities.reduce((sum, s) => sum + (d[s] || 0), 0)) || 0;

    const y = d3.scaleLinear()
      .domain([0, maxTotal])
      .nice()
      .range([height, 0]);

    const sevColors = { Slight: "#4daf4a", Serious: "#ff9800", Fatal: "#e41a1c" };
    const color = d3.scaleOrdinal()
      .domain(severities)
      .range(severities.map(s => sevColors[s] || "#999"));

    // stack
    const stacked = d3.stack().keys(severities)(byHour);

    // layers join
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
      .duration(350)
      .attr("x", d => x(d.data.hour))
      .attr("width", x.bandwidth())
      .attr("y", d => y(d[1]))
      .attr("height", d => y(d[0]) - y(d[1]));

    // axes
    g.select(".x-axis")
      .call(d3.axisBottom(x).tickFormat(d => `${d}:00`).tickValues(d3.range(0, 24, 2)));
    g.select(".y-axis")
      .call(d3.axisLeft(y));

    styleAxisWhite(g.select(".x-axis"));
    styleAxisWhite(g.select(".y-axis"));

    // legend
    const legend = g.select(".legend");
    const items = legend.selectAll("g.item").data(severities, d => d);
    items.exit().remove();

    const itemsEnter = items.enter()
      .append("g")
      .attr("class", "item")
      .attr("transform", (d, i) => `translate(0, ${i * 22})`);

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

  // Expose
  window.barchartModule = { prepareRows, init };
})();
