(function () {
  const WEEKDAYS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

  function jsDayToMonFirst(jsDay) { return (jsDay + 6) % 7; }

  function dateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  const parseDate = d3.timeParse("%d/%m/%Y");

  function parseHour(s) {
    if (!s) return null;
    const m = String(s).trim().match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const h = Number(m[1]);
    return Number.isFinite(h) && h >= 0 && h <= 23 ? h : null;
    }

  function emptyGrid() {
    const grid = [];
    for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) grid.push({ w, h, count: 0, days: 0, avg: 0 });
    return grid;
  }

  // IMPORTANT: avg is computed once and stored in each cell
  function aggregateAvgPerDay(rows) {
    const counts = new Map(); // "w|h" -> count
    const weekdayDays = Array.from({ length: 7 }, () => new Set()); // distinct day keys per weekday

    for (const r of rows) {
      const k = `${r.weekdayIndex}|${r.hour}`;
      counts.set(k, (counts.get(k) || 0) + 1);
      weekdayDays[r.weekdayIndex].add(r.dayKey);
    }

    const denom = weekdayDays.map(s => s.size); // days per weekday in selection (0 possible)

    const grid = emptyGrid();
    for (const cell of grid) {
      const k = `${cell.w}|${cell.h}`;
      const c = counts.get(k) || 0;
      const days = denom[cell.w] || 0;

      cell.count = c;
      cell.days = days;
      cell.avg = (days > 0) ? (c / days) : 0;
    }
    return grid;
  }

  function computeFixedMax(preparedRows) {
    let maxAvg = 0;

    maxAvg = Math.max(maxAvg, d3.max(aggregateAvgPerDay(preparedRows), d => d.avg) || 0);

    for (let m = 0; m < 12; m++) {
      const sel = preparedRows.filter(r => r.monthIndex === m);
      maxAvg = Math.max(maxAvg, d3.max(aggregateAvgPerDay(sel), d => d.avg) || 0);
    }

    return maxAvg;
  }

  function createHeatmap(slotSelector) {
    const container = d3.select(slotSelector);
    container.selectAll("*").remove();

    // ---------- Legend (top-right, inline styles) ----------
const legend = container.append("div")
  .style("position", "absolute")
  .style("top", "10px")
  .style("right", "10px")
  .style("background", "rgba(0,0,0,0.35)")
  .style("border", "1px solid rgba(255,255,255,0.15)")
  .style("border-radius", "10px")
  .style("padding", "8px 10px")
  .style("color", "#ffffff")
  .style("font-size", "12px")
  .style("z-index", 15)
  .style("pointer-events", "none");

legend.append("div")
  .style("font-weight", "800")
  .style("margin-bottom", "6px")
  .text("Accidents");

const legendBar = legend.append("div")
  .style("width", "160px")
  .style("height", "12px")
  .style("border-radius", "999px")
  .style("border", "1px solid rgba(255,255,255,0.2)")
  .style("margin-bottom", "6px");

legend.append("div")
  .style("display", "flex")
  .style("justify-content", "space-between")
  .style("font-size", "11px")
  .style("font-weight", "700")
  .style("opacity", "0.85")
  .html("<span>Few accidents</span><span>Many accidents</span>");


    // Tooltip
    const tooltip = container.append("div")
      .attr("class", "tooltip")
      .style("position", "absolute")
      .style("pointer-events", "none")
      .style("background", "rgba(0,0,0,0.85)")
      .style("color", "#fff")
      .style("padding", "8px 10px")
      .style("border-radius", "10px")
      .style("font-size", "12px")
      .style("opacity", 0)
      .style("transition", "opacity 0.08s linear")
      .style("z-index", 10);

    const svg = container.append("svg")
      .attr("width", "100%")
      .attr("height", "100%");

    const g = svg.append("g");
    const gx = g.append("g");
    const gy = g.append("g");
    const cellsG = g.append("g");
    const overlayTextG = g.append("g").attr("pointer-events", "none");

    const margin = { top: 16, right: 10, bottom: 40, left: 44 };
    const x = d3.scaleBand().domain(d3.range(24));
    const y = d3.scaleBand().domain(d3.range(7));

    let maxAvg = 1;

    // Stronger red
    const color = d3.scaleLinear()
      .domain([0, 1])
      .range(["#2ecc71", "#8B0000"])
      .interpolate(d3.interpolateRgb);

    legendBar.style(
  "background",
  `linear-gradient(to right, ${color.range()[0]}, ${color.range()[1]})`
);


    const fmtAvg = d3.format(".2f");

    function setFixedScaleMax(v) {
      maxAvg = Math.max(1e-9, v);
      color.domain([0, maxAvg]);
    }

    function isFullscreenNow() {
      const panel = container.node().closest(".panel");
      return !!panel && panel.classList.contains("isFullscreen");
    }

    function tooltipShow(event, cell) {
      tooltip.style("opacity", 1)
        .html(
          `<div><b>${WEEKDAYS[cell.w]}</b> ${String(cell.h).padStart(2,"0")}:00</div>` +
          `<div>Avg / day: <b>${fmtAvg(cell.avg)}</b></div>` +
          `<div>Total accidents: ${cell.count}</div>` +
          `<div>Days used: ${cell.days}</div>`
        );
      tooltipMove(event);
    }

    function tooltipHide() {
      tooltip.style("opacity", 0);
    }

    // overflow-safe tooltip positioning
    function tooltipMove(event) {
      const rect = container.node().getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      const tipNode = tooltip.node();
      const tipW = tipNode.offsetWidth || 0;
      const tipH = tipNode.offsetHeight || 0;

      const pad = 12;
      const edgePad = 8;

      let xPos = mouseX + pad;
      let yPos = mouseY + pad;

      const maxX = rect.width - tipW - edgePad;
      const maxY = rect.height - tipH - edgePad;

      if (xPos > maxX) xPos = mouseX - pad - tipW;
      if (yPos > maxY) yPos = mouseY - pad - tipH;

      xPos = Math.max(edgePad, Math.min(xPos, maxX));
      yPos = Math.max(edgePad, Math.min(yPos, maxY));

      tooltip.style("left", `${xPos}px`).style("top", `${yPos}px`);
    }

    function clearOverlay() {
      overlayTextG.selectAll("*").remove();
    }

    function drawRowColNumbers(gridMap, focusCell) {
      clearOverlay();
      if (!isFullscreenNow()) return;

      const fontSize = Math.max(10, Math.min(14, Math.min(x.bandwidth(), y.bandwidth()) * 0.35));

      // build row+col lists via map lookups (guaranteed same source as tooltip)
      const rowCells = [];
      const colCells = [];

      for (let hh = 0; hh < 24; hh++) rowCells.push(gridMap.get(`${focusCell.w}|${hh}`));
      for (let ww = 0; ww < 7; ww++) colCells.push(gridMap.get(`${ww}|${focusCell.h}`));

      const safe = (c) => (c ? fmtAvg(c.avg) : "");

      // Column
      overlayTextG.selectAll("text.col")
        .data(colCells.filter(Boolean), d => `c-${d.w}-${d.h}`)
        .enter()
        .append("text")
        .attr("class", "col")
        .attr("x", d => x(d.h) + x.bandwidth() / 2)
        .attr("y", d => y(d.w) + y.bandwidth() / 2)
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "middle")
        .attr("fill", "#ffffff")
        .attr("font-size", fontSize)
        .attr("font-weight", 800)
        .text(d => safe(d));

      // Row
      overlayTextG.selectAll("text.row")
        .data(rowCells.filter(Boolean), d => `r-${d.w}-${d.h}`)
        .enter()
        .append("text")
        .attr("class", "row")
        .attr("x", d => x(d.h) + x.bandwidth() / 2)
        .attr("y", d => y(d.w) + y.bandwidth() / 2)
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "middle")
        .attr("fill", "#ffffff")
        .attr("font-size", fontSize)
        .attr("font-weight", 800)
        .text(d => safe(d));
    }

    let lastGrid = null;
    let lastGridMap = null;

    function render(grid) {
      lastGrid = grid;

      // Build map from THIS grid (single source of truth)
      const gridMap = new Map();
      for (const c of grid) gridMap.set(`${c.w}|${c.h}`, c);
      lastGridMap = gridMap;

      const node = container.node();
      const W = node.clientWidth || 10;
      const H = node.clientHeight || 10;

      const innerW = Math.max(10, W - margin.left - margin.right);
      const innerH = Math.max(10, H - margin.top - margin.bottom);

      g.attr("transform", `translate(${margin.left},${margin.top})`);
      x.range([0, innerW]).paddingInner(0.06);
      y.range([0, innerH]).paddingInner(0.06);

      gx.attr("transform", `translate(0,${innerH})`)
        .call(d3.axisBottom(x).tickValues(d3.range(0,24,2)).tickFormat(d => String(d).padStart(2,"0")));
      gy.call(d3.axisLeft(y).tickFormat(d => WEEKDAYS[d]));

      gx.selectAll("text").attr("fill", "#d8d8d8").attr("font-size", 10);
      gy.selectAll("text").attr("fill", "#d8d8d8").attr("font-size", 10);
      gx.selectAll("path,line").attr("stroke", "#666");
      gy.selectAll("path,line").attr("stroke", "#666");

      clearOverlay();

      // IMPORTANT: no transition here to avoid stale hover data issues
      const sel = cellsG.selectAll("rect").data(grid, d => `${d.w}|${d.h}`);

      sel.join(
        enter => enter.append("rect")
          .attr("x", d => x(d.h))
          .attr("y", d => y(d.w))
          .attr("width", x.bandwidth())
          .attr("height", y.bandwidth())
          .attr("rx", 3)
          .attr("fill", d => color(d.avg))
          .on("mouseenter", (event, d) => {
            const cell = lastGridMap.get(`${d.w}|${d.h}`); // single truth
            if (!cell) return;
            tooltipShow(event, cell);
            drawRowColNumbers(lastGridMap, cell);
          })
          .on("mousemove", (event, d) => {
            const cell = lastGridMap.get(`${d.w}|${d.h}`);
            if (!cell) return;
            tooltipMove(event);
          })
          .on("mouseleave", () => {
            tooltipHide();
            clearOverlay();
          }),
        update => update
          .attr("x", d => x(d.h))
          .attr("y", d => y(d.w))
          .attr("width", x.bandwidth())
          .attr("height", y.bandwidth())
          .attr("fill", d => color(d.avg))
      );
    }

    const ro = new ResizeObserver(() => {
      if (lastGrid) render(lastGrid);
    });
    ro.observe(container.node());

    return { setFixedScaleMax, render };
  }

  window.HeatmapModule = {
    prepareRows(rawRows) {
      const out = [];
      for (const r of rawRows) {
        const d = parseDate(r["Accident Date"]);
        const h = parseHour(r["Time"]);
        if (!d || h === null) continue;

        out.push({
          dayKey: dateKey(d),
          monthIndex: d.getMonth(),
          weekdayIndex: jsDayToMonFirst(d.getDay()),
          hour: h
        });
      }
      return out;
    },

    computeFixedMax,

    init({ slotSelector, preparedRows }) {
      const hm = createHeatmap(slotSelector);

      return {
        setFixedScaleMax: hm.setFixedScaleMax,
        update(state) {
          const rows = (state.mode === "MONTH")
            ? preparedRows.filter(r => r.monthIndex === state.monthIndex)
            : preparedRows;

          const grid = aggregateAvgPerDay(rows);
          hm.render(grid);
        }
      };
    }
  };
})();
