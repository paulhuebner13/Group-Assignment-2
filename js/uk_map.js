// js/uk_map.js
(function () {

  const parseDate = d3.timeParse("%d/%m/%Y");

  function prepareRows(rawRows) {
    return rawRows.map(r => {
      const d = parseDate(r["Accident Date"]);
      return {
  longitude: +r.Longitude,
  latitude: +r.Latitude,
  severity: r.Accident_Severity,
  district: r["Local_Authority_(District)"] || "",
  monthIndex: d ? d.getMonth() : null,
  weekdayIndex: d ? ((d.getDay() + 6) % 7) : null // Mon=0 ... Sun=6
};

    }).filter(d =>
  Number.isFinite(d.longitude) &&
  Number.isFinite(d.latitude) &&
  d.monthIndex !== null &&
  d.weekdayIndex !== null
);

  }

  window.UKMapModule = {
    prepareRows,

    init({ slotSelector, preparedRows }) {
      // Grid size in projected pixels zoom exponent keeps pies from exploding into too many tiny bins.
      const BASE_GRID_SIZE_PX = 64;
      const MIN_GRID_SIZE_PX = 18;
      const MAX_GRID_SIZE_PX = 160;
      const GRID_ZOOM_EXPONENT = 0.6;
      const GRID_QUANTUM_PX = 2; // quantize grid to reduce jitter on minor zoom changes

      // Point rendering LOD
      const POINT_DETAIL_ZOOM = 1.55; // switch from density view to full dots
      const DENSITY_ALPHA_MAX = 0.12;
      const DENSITY_ALPHA_MIN = 0.025;
      const DENSITY_RADIUS_MULT = 0.8;

      const container = d3.select(slotSelector);
      container.selectAll("*").remove();
      container.style("position", "relative");

      const node = container.node();
      const width = node.clientWidth || 300;
      const height = node.clientHeight || 300;

      // Layering: base SVG for land/water -> canvas for dots -> overlay SVG for borders/pies/coastline.
      const svgBase = container.append("svg")
        .attr("width", width)
        .attr("height", height)
        .style("position", "absolute")
        .style("inset", 0)
        .style("z-index", 1);

      const canvas = container.append("canvas")
        .attr("width", width)
        .attr("height", height)
        .style("position", "absolute")
        .style("inset", 0)
        .style("z-index", 2)
        .style("width", "100%")
        .style("height", "100%");

      const ctx = canvas.node().getContext("2d");

      const svg = container.append("svg")
        .attr("width", width)
        .attr("height", height)
        .style("position", "absolute")
        .style("inset", 0)
        .style("z-index", 3);

      // Tooltip (for pie chart hover)
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
        .style("z-index", 10)
        .style("max-width", "320px");

      // Background (ocean stays static while zooming)
      svgBase.append("rect")
        .attr("width", width)
        .attr("height", height)
        .attr("fill", "#7fb7e6")
        .attr("fill-opacity", 0.7);

      // Root groups transformed by zoom
      const gBaseRoot = svgBase.append("g");
      const gRoot = svg.append("g");

      // Separate layers (VERY important)
      const gLand = gBaseRoot.append("g");
      const gInnerBorders = gRoot.append("g");
      const gPies = gRoot.append("g");
      const gCoast = gRoot.append("g");

      const projection = d3.geoMercator()
        .center([-2, 54])
        .scale(2000)
        .translate([width / 2, height / 2]);

      const path = d3.geoPath().projection(projection);

      const severityOrder = ["Fatal", "Serious", "Slight"];

      // Slightly punchier palette for the DOTS view (keeps Fatal/Serious more visible)
      const dotColor = d3.scaleOrdinal()
        .domain(severityOrder)
        .range(["#ff1f3d", "#ff7a00", "#ffd166"]);

      const pieGenerator = d3.pie()
        .value(d => d.value)
        .sort((a, b) => severityOrder.indexOf(a.key) - severityOrder.indexOf(b.key));

      const londonBoroughs = new Set([
        "barking and dagenham", "barnet", "bexley", "brent", "bromley", "camden",
        "croydon", "ealing", "enfield", "greenwich", "hackney",
        "hammersmith and fulham", "haringey", "harrow", "havering", "hillingdon",
        "hounslow", "islington", "kensington and chelsea", "kingston upon thames",
        "lambeth", "lewisham", "merton", "newham", "redbridge", "richmond upon thames",
        "southwark", "sutton", "tower hamlets", "waltham forest", "wandsworth",
        "westminster", "city of london"
      ]);

      const normalizeDistrict = (d) => (d || "").trim().toLowerCase();
      const isLondonDistrict = (d) => londonBoroughs.has(normalizeDistrict(d));

      // GeoJSON cached for drawing
      let mapFeatures = null;
      let lastState = { mode: "ALL", monthIndex: 0, mapView: "DOTS" };

      // Pre-project all points once; also bucket by month to avoid filtering 300k rows repeatedly.
      const rowsByMonth = Array.from({ length: 12 }, () => []);
      const rowsByMonthNoSlight = Array.from({ length: 12 }, () => []);
      const districtStats = new Map();
      const allRowsNoSlight = [];
      const allRows = preparedRows.map(r => {
        const [x, y] = projection([r.longitude, r.latitude]);
        const row = { ...r, x, y };
        rowsByMonth[row.monthIndex].push(row);
        if (row.severity !== "Slight") {
          rowsByMonthNoSlight[row.monthIndex].push(row);
          allRowsNoSlight.push(row);
        }
        const key = normalizeDistrict(row.district);
        if (!districtStats.has(key)) {
          districtStats.set(key, { name: row.district || "Unknown", sumX: 0, sumY: 0, count: 0, isLondon: isLondonDistrict(row.district) });
        }
        const stats = districtStats.get(key);
        stats.sumX += x;
        stats.sumY += y;
        stats.count += 1;
        return row;
      });

      // Radii chosen so Fatal > Serious > Slight for immediate visual priority.
      const dotBaseRadius = (d) => (d.severity === "Fatal") ? 3.6 : (d.severity === "Serious") ? 2.8 : 2.2;
      const dotBaseOpacity = (d) => (d.severity === "Fatal") ? 0.95 : (d.severity === "Serious") ? 0.35 : 0.9;
      const dotBaseStrokeWidth = 0.35;
      const dotStrokeColor = "#0b1f33";
      const dotDensityGridPx = 28;
      const dotQuantPx = 0.5;

      // Keep track of zoom so we can keep dots a constant on-screen size.
      let currentTransform = d3.zoomIdentity;
      let currentRows = allRows;
      let activeRows = allRows;
      let dotsVisible = false;
      let pendingPieRefresh = false;
      let lastRenderedGridSize = BASE_GRID_SIZE_PX;
      const labelMemory = new Map();
      let lastDotsRowsRef = null;
      let currentDotLayout = null;

      const clampGridSize = (size) =>
        Math.max(MIN_GRID_SIZE_PX, Math.min(MAX_GRID_SIZE_PX, size));

      function effectiveGridSizePx() {
        const k = (currentTransform && currentTransform.k) ? currentTransform.k : 1;
        const scaled = BASE_GRID_SIZE_PX / Math.max(Math.pow(k, GRID_ZOOM_EXPONENT), 0.0001);
        const clamped = clampGridSize(scaled);
        const quantized = Math.max(MIN_GRID_SIZE_PX, Math.min(MAX_GRID_SIZE_PX, Math.round(clamped / GRID_QUANTUM_PX) * GRID_QUANTUM_PX));
        return quantized;
      }

      function requestPieRender(force = false) {
        if (pendingPieRefresh) return;
        pendingPieRefresh = true;
        requestAnimationFrame(() => {
          pendingPieRefresh = false;
          if (lastState.mapView !== "PIES" || !mapFeatures) return;
          const nextGrid = effectiveGridSizePx();
          if (!force && Math.abs(nextGrid - lastRenderedGridSize) < 0.25) return;
          renderPies(currentRows || []);
        });
      }

      function clearDots() {
        ctx.clearRect(0, 0, width, height);
        canvas.style("opacity", 0);
        dotsVisible = false;
      }

      function buildDotLayout(rows) {
        const aggMap = new Map();
        for (const r of rows) {
          const qx = Math.round(r.x / dotQuantPx) * dotQuantPx;
          const qy = Math.round(r.y / dotQuantPx) * dotQuantPx;
          const key = `${qx},${qy}`;
          let bucket = aggMap.get(key);
          if (!bucket) {
            bucket = { x: qx, y: qy, Fatal: 0, Serious: 0, Slight: 0, total: 0 };
            aggMap.set(key, bucket);
          }
          if (bucket[r.severity] !== undefined) bucket[r.severity] += 1;
          bucket.total += 1;
        }

        const points = [];
        let maxTotal = 0;
        for (const bucket of aggMap.values()) {
          maxTotal = Math.max(maxTotal, bucket.total);
          const topSeverity = bucket.Fatal > 0 ? "Fatal" : bucket.Serious > 0 ? "Serious" : "Slight";
          points.push({ ...bucket, severity: topSeverity });
        }

        // Compute density per grid cell using aggregated totals.
        const densityBins = new Map();
        for (const p of points) {
          const gx = Math.floor(p.x / dotDensityGridPx);
          const gy = Math.floor(p.y / dotDensityGridPx);
          const key = `${gx},${gy}`;
          let bin = densityBins.get(key);
          if (!bin) {
            bin = { total: 0, Fatal: 0, Serious: 0, Slight: 0 };
            densityBins.set(key, bin);
          }
          bin.total += p.total;
          bin.Fatal += p.Fatal;
          bin.Serious += p.Serious;
          bin.Slight += p.Slight;
        }

        let maxDensity = 0;
        for (const bin of densityBins.values()) {
          maxDensity = Math.max(maxDensity, bin.total);
        }
        for (const p of points) {
          const gx = Math.floor(p.x / dotDensityGridPx);
          const gy = Math.floor(p.y / dotDensityGridPx);
          const binKey = `${gx},${gy}`;
          const bin = densityBins.get(binKey);
          const dTotal = bin ? bin.total : p.total;
          p.densityTotal = dTotal;
        }

        return { points, maxTotal, maxDensity, densityBins, densityGridSize: dotDensityGridPx };
      }

      function getDotLayout(rows) {
        if (rows === lastDotsRowsRef && currentDotLayout) return currentDotLayout;
        currentDotLayout = buildDotLayout(rows);
        lastDotsRowsRef = rows;
        return currentDotLayout;
      }

      function renderDots(rows, reuseLayout = false) {
        activeRows = rows;
        canvas.style("opacity", 1);
        dotsVisible = true;

        const layout = reuseLayout && currentDotLayout && rows === lastDotsRowsRef
          ? currentDotLayout
          : getDotLayout(rows);

        ctx.clearRect(0, 0, width, height);

        const k = (currentTransform && currentTransform.k) ? currentTransform.k : 1;
        const invK = 1 / k;
        const strokeW = dotBaseStrokeWidth * invK;
        const detailMode = k >= POINT_DETAIL_ZOOM;
        const sevFilter = lastState.severityFilter || { Fatal: true, Serious: true, Slight: true };

        const countScale = d3.scaleSqrt()
          .domain([1, Math.max(1, layout.maxTotal)])
          .range(detailMode ? [1, 2.0] : [1, 1.05]);

        const densityScale = detailMode
          ? d3.scaleSqrt()
            .domain([1, Math.max(1, layout.maxDensity)])
            .range([1, 1.25])
          : null;

        const mixColor = () => "rgb(128,162,205)"; // neutral blue-ish density to avoid orange wash

        ctx.save();
        ctx.translate(currentTransform.x, currentTransform.y);
        ctx.scale(k, k);
        ctx.lineWidth = strokeW;
        ctx.strokeStyle = dotStrokeColor;

        const renderDensityLayer = () => {
          ctx.save();
          ctx.filter = "blur(8px)";
          for (const [key, bin] of layout.densityBins.entries()) {
            if (!bin.total) continue;
            const [gx, gy] = key.split(",").map(Number);
            const cx = (gx + 0.5) * (layout.densityGridSize || dotDensityGridPx);
            const cy = (gy + 0.5) * (layout.densityGridSize || dotDensityGridPx);
            const intensity = Math.sqrt(bin.total / Math.max(1, layout.maxDensity));
            const alpha = DENSITY_ALPHA_MIN + intensity * (DENSITY_ALPHA_MAX - DENSITY_ALPHA_MIN);
            ctx.globalAlpha = alpha;
            ctx.fillStyle = mixColor(bin);
            const radius = (layout.densityGridSize || dotDensityGridPx) * DENSITY_RADIUS_MULT;
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.filter = "none";
          ctx.restore();
        };

        const renderFocusPoints = () => {
          for (const sev of severityOrder) {
            ctx.fillStyle = dotColor(sev);
            for (const p of layout.points) {
              if (p.severity !== sev) continue;
              if (!sevFilter[sev]) continue;
              const base = dotBaseRadius({ severity: sev }) * invK;
              const rScale = detailMode
                ? 1
                : (sev === "Fatal" ? 0.65 : sev === "Serious" ? 0.6 : 0.55);
              const r = base * countScale(p.total) * (densityScale ? densityScale(p.densityTotal) : 1) * rScale;

              if (p.Fatal > 0) {
                ctx.save();
                ctx.lineWidth = Math.max(0.6, 1.0 * invK);
                const haloAlpha = detailMode ? 0.22 : 0.14;
                ctx.strokeStyle = `rgba(255,31,61,${haloAlpha})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, r * 1.9, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
              } else if (p.Serious > 0) {
                ctx.save();
                ctx.lineWidth = Math.max(0.5, 0.9 * invK);
                const haloAlpha = detailMode ? 0.18 : 0.12;
                ctx.strokeStyle = `rgba(255,122,0,${haloAlpha})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, r * 1.6, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
              }

              const baseAlpha = dotBaseOpacity({ severity: sev });
              const alpha = detailMode
                ? baseAlpha
                : (sev === "Slight" ? baseAlpha * 0.32 : baseAlpha * 0.45);
              ctx.globalAlpha = alpha;
              ctx.beginPath();
              ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
            }
          }
        };

        if (!detailMode) {
          renderDensityLayer();
          renderFocusPoints();
          ctx.restore();
          ctx.globalAlpha = 1;
          return;
        }

        for (const sev of severityOrder) {
          ctx.fillStyle = dotColor(sev);
          for (const p of layout.points) {
            if (p.severity !== sev) continue;
            if (!sevFilter[sev]) continue;
            const base = dotBaseRadius({ severity: sev }) * invK;
            const r = base * countScale(p.total) * densityScale(p.densityTotal);

            // Halo to emphasize higher severity
            if (p.Fatal > 0) {
              ctx.save();
              ctx.lineWidth = Math.max(0.8, 1.4 * invK);
              ctx.strokeStyle = "rgba(255,31,61,0.45)";
              ctx.beginPath();
              ctx.arc(p.x, p.y, r * 1.9, 0, Math.PI * 2);
              ctx.stroke();
              ctx.restore();
            } else if (p.Serious > 0) {
              ctx.save();
              ctx.lineWidth = Math.max(0.6, 1.0 * invK);
              ctx.strokeStyle = "rgba(255,122,0,0.32)";
              ctx.beginPath();
              ctx.arc(p.x, p.y, r * 1.6, 0, Math.PI * 2);
              ctx.stroke();
              ctx.restore();
            }

            ctx.globalAlpha = dotBaseOpacity({ severity: sev }) * (detailMode ? 1 : 0.55);
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }

        ctx.restore();
        ctx.globalAlpha = 1;
      }

      // ---- Zoom & pan ----
      const zoom = d3.zoom()
        // Allow zooming out below the initial scale
        .scaleExtent([0.6, 10])
        .on("zoom", (event) => {
          currentTransform = event.transform;
          gRoot.attr("transform", currentTransform);
          gBaseRoot.attr("transform", currentTransform);
          if (dotsVisible) {
            renderDots(activeRows, true);
          } else if (lastState.mapView === "PIES") {
            requestPieRender();
          }
        });

      // Attach zoom to the SVG so hover events on marks still work.
      svg.call(zoom);
      svg.style("cursor", "grab");
      svg
        .on("mousedown.cursor", () => svg.style("cursor", "grabbing"))
        .on("mouseup.cursor", () => svg.style("cursor", "grab"))
        .on("mouseleave.cursor", () => svg.style("cursor", "grab"));

      // ---- Draw base map ONCE ----
      d3.json("data/gb.json").then(geojson => {
        mapFeatures = geojson.features;

        // Land layer
        gLand.selectAll("path.land")
          .data(mapFeatures)
          .join("path")
          .attr("class", "land")
          .attr("d", path)
          // Land is always white; points on top show accident locations.
          .attr("fill", "#f3d6cf")
          .attr("stroke", "none");

        // Inner borders (only shown in DOTS / points view)
        // Note: drawing per-feature outlines includes the outer edge too, but the outer coastline
        // is drawn separately below; we keep these borders subtle so the coast doesn't look doubled.
        gInnerBorders.selectAll("path.inner-borders")
          .data(mapFeatures)
          .join("path")
          .attr("class", "inner-borders")
          .attr("d", path)
          .attr("fill", "none")
          .attr("stroke", "#0b1f33")
          .attr("stroke-opacity", 0.32)
          .attr("stroke-width", 0.65)
          .attr("stroke-linejoin", "round")
          .attr("stroke-linecap", "round")
          .attr("vector-effect", "non-scaling-stroke")
          .attr("pointer-events", "none");

        // Coastline contour ABOVE points
        // Draw ONLY the outer coastline by merging all polygons.
        // (Stroking each feature produces interior borders at shared edges.)
        const mergedOutline = d3.geoMerge(mapFeatures.map(f => f.geometry));

        gCoast.selectAll("path.coastline")
          .data([mergedOutline])
          .join("path")
          .attr("class", "coastline")
          .attr("d", path)
          .attr("fill", "none")
          .attr("stroke", "#0b1f33")
          .attr("stroke-opacity", 0.9)
          .attr("stroke-width", 0.7)
          .attr("stroke-linejoin", "round")
          .attr("stroke-linecap", "round")
          .attr("vector-effect", "non-scaling-stroke");

        // If the user is currently in pie view, render once geo is ready.
        if (lastState.mapView === "PIES") {
          renderPies(filteredRows(lastState));
        }
      });

      function filteredRows(state) {
  const sevFilter = state.severityFilter || { Fatal: true, Serious: true, Slight: true };
  const monthIdx = state.mode === "MONTH" ? state.monthIndex : null;

  const base = state.mode === "MONTH"
    ? (rowsByMonth[monthIdx] || [])
    : allRows;

  return base.filter(r => {
    if (!sevFilter[r.severity]) return false;

    if (state.weekdayFilter !== null && state.weekdayFilter !== undefined) {
      if (r.weekdayIndex !== state.weekdayFilter) return false;
    }

    return true;
  });
}


      function tooltipHide() {
        tooltip.style("opacity", 0);
      }

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

      function tooltipShowPie(event, pie) {
        const region = pie.label || "Unknown";
        const topList = (pie.topDistricts && pie.topDistricts.length)
          ? pie.topDistricts.map(d => `${d.name} (${d.count})`).join(", ")
          : "";

        tooltip
          .style("opacity", 1)
          .html(
            `<div><b>Region:</b> ${region}</div>` +
            (topList ? `<div><b>Top districts:</b> ${topList}</div>` : "") +
            `<div style="margin-top:6px;"><b>Total:</b> ${pie.total}</div>` +
            `<div>Fatal: <b>${pie.Fatal}</b></div>` +
            `<div>Serious: <b>${pie.Serious}</b></div>` +
            `<div>Slight: <b>${pie.Slight}</b></div>`
          );
        tooltipMove(event);
      }

      function renderPies(rows, gridSizeOverride) {
        tooltipHide();
        const gridSize = gridSizeOverride || effectiveGridSizePx();
        lastRenderedGridSize = gridSize;

        // Bin accidents into a zoom-aware projected grid to reduce overlap and allow splitting while zooming.
        const binMap = new Map();

        for (const r of rows) {
          const x = r.x;
          const y = r.y;
          const gx = Math.floor(x / gridSize);
          const gy = Math.floor(y / gridSize);
          const key = `${gx},${gy}`;

          let bucket = binMap.get(key);
          if (!bucket) {
            bucket = {
              gx,
              gy,
              sumX: 0,
              sumY: 0,
              Fatal: 0,
              Serious: 0,
              Slight: 0,
              total: 0,
              districtCounts: new Map()
            };
            binMap.set(key, bucket);
          }

          bucket.sumX += x;
          bucket.sumY += y;
          if (bucket[r.severity] !== undefined) bucket[r.severity] += 1;
          bucket.total += 1;

        const district = (r.district || "").trim() || "Unknown";
        bucket.districtCounts.set(district, (bucket.districtCounts.get(district) || 0) + 1);
      }

        const piesData = [];
        let maxTotal = 0;

        for (const bucket of binMap.values()) {
          if (bucket.total <= 0) continue;
          maxTotal = Math.max(maxTotal, bucket.total);
          const cx = bucket.sumX / bucket.total;
          const cy = bucket.sumY / bucket.total;

          const districtsSorted = Array.from(bucket.districtCounts.entries())
            .sort((a, b) => b[1] - a[1]);
          const primaryEntry = districtsSorted[0] || ["Unknown", 0];
          const secondaryEntry = districtsSorted[1] || ["", 0];
          const topDistricts = districtsSorted.slice(0, 3).map(([name, count]) => ({ name, count }));

          const londonCount = districtsSorted.reduce((sum, [name, count]) =>
            sum + (isLondonDistrict(name) ? count : 0), 0);
          const topCount = primaryEntry[1];
          const topShare = (bucket.total > 0) ? (topCount / bucket.total) : 0;
          const secondaryShare = (bucket.total > 0) ? (secondaryEntry[1] / bucket.total) : 0;
          const londonShare = (bucket.total > 0) ? (londonCount / bucket.total) : 0;

          const bucketKey = `${gridSize.toFixed(2)}|${bucket.gx},${bucket.gy}`;
          const prevLabel = labelMemory.get(bucketKey);

          const centroidLabel = (() => {
            // Prefer centroids of districts already in the bucket; fall back to the top district name.
            const candidates = districtsSorted.length ? districtsSorted : [["Unknown", 0]];
            let best = candidates[0][0];
            let bestDist = Infinity;
            for (const [name] of candidates) {
              const norm = normalizeDistrict(name);
              const stats = districtStats.get(norm);
              if (!stats || stats.count === 0) continue;
              const cx0 = stats.sumX / stats.count;
              const cy0 = stats.sumY / stats.count;
              const dx = cx0 - cx;
              const dy = cy0 - cy;
              const dist = dx * dx + dy * dy;
              if (dist < bestDist) {
                bestDist = dist;
                best = stats.name || name;
              }
            }
            return best || primaryEntry[0] || "Unknown";
          })();

          let label = primaryEntry[0] || centroidLabel || "Unknown";
          if (londonShare >= 0.55) {
            // London dominates; show borough only if it strongly leads.
            if (isLondonDistrict(primaryEntry[0]) && topShare >= 0.65) {
              label = primaryEntry[0];
            } else {
              label = "London";
            }
          } else if (topShare < 0.5 && secondaryShare >= 0.35 && secondaryEntry[0]) {
            // Two strong contributors: show both.
            label = `${primaryEntry[0]} & ${secondaryEntry[0]}`;
          } else if (topShare < 0.4) {
            // No clear leader: fall back to nearest centroid for geographic relevance.
            label = centroidLabel;
          }

          if (prevLabel && prevLabel.label) {
            // Hysteresis: keep previous label unless the new leader clearly wins.
            const prevIsLondon = prevLabel.label === "London";
            if (prevLabel.label === label) {
              // keep as-is
            } else if (prevIsLondon && londonShare >= 0.45) {
              label = prevLabel.label;
            } else if (prevLabel.label === primaryEntry[0] && topShare >= Math.max(prevLabel.leadShare + 0.1, 0.45)) {
              // new leader is significantly ahead; allow switch
            } else if (prevLabel.label !== primaryEntry[0] && (topShare - (secondaryShare || 0)) < 0.12) {
              // avoid jitter when leaders are close
              label = prevLabel.label;
            } else if (topShare < 0.5 && prevLabel.label) {
              label = prevLabel.label;
            }
          }

          labelMemory.set(bucketKey, { label, leadShare: topShare });

          piesData.push({
            key: `${bucket.gx},${bucket.gy}`,
            cx,
            cy,
            Fatal: bucket.Fatal,
            Serious: bucket.Serious,
            Slight: bucket.Slight,
            total: bucket.total,
            gridSize,
            label,
            topDistricts
          });
        }

        const k = (currentTransform && currentTransform.k) ? currentTransform.k : 1;
        const invK = 1 / k;
        const cellScreen = gridSize * k;
        const minRadiusPx = Math.max(6, Math.min(18, cellScreen * 0.32));
        const maxRadiusPx = Math.max(minRadiusPx + 2, Math.min(36, cellScreen * 0.66));

        const radiusScale = d3.scaleSqrt()
          .domain([1, Math.max(1, maxTotal)])
          .range([minRadiusPx * invK, maxRadiusPx * invK]);

        const groups = gPies.selectAll("g.pie")
          .data(piesData, d => `${d.gridSize.toFixed(2)}|${d.key}`);

        const groupsEnter = groups.enter()
          .append("g")
          .attr("class", "pie")
          .attr("transform", d => `translate(${d.cx},${d.cy})`)
          .attr("opacity", 0);

        groups.merge(groupsEnter)
          .attr("transform", d => `translate(${d.cx},${d.cy})`);

        groupsEnter.transition().duration(200).attr("opacity", 1);
        groups.exit().remove();

        gPies.selectAll("g.pie").each(function (d) {
          const radius = radiusScale(d.total);

          const slices = severityOrder.map(key => ({ key, value: d[key] || 0 }));
          const arcs = pieGenerator(slices).filter(a => a.data.value > 0);

          // Emphasize Fatal slice visually (without changing angles/proportions)
          const baseArc = d3.arc()
            .innerRadius(0)
            .outerRadius(radius);

          const arcGen = (a) => d3.arc()
            .innerRadius(0)
            .outerRadius(radius + (a.data.key === "Fatal" ? 3 : 0))(a);

          const fatalOffset = Math.min(6, radius * 0.18);
          const arcTranslate = (a) => {
            if (a.data.key !== "Fatal" || !a.data.value) return null;
            const [cx, cy] = baseArc.centroid(a);
            const len = Math.hypot(cx, cy) || 1;
            const dx = (cx / len) * fatalOffset;
            const dy = (cy / len) * fatalOffset;
            return `translate(${dx},${dy})`;
          };

          const sel = d3.select(this).selectAll("path")
            .data(arcs, a => a.data.key);

          sel.join(
            enter => enter.append("path")
              .attr("fill", a => dotColor(a.data.key))
              .attr("opacity", a => (a.data.key === "Fatal" ? 1 : 0.82))
              .attr("stroke", a => (a.data.key === "Fatal" ? "#ffffff" : "#0b1f33"))
              .attr("stroke-opacity", a => (a.data.key === "Fatal" ? 0.9 : 0.55))
              .attr("stroke-width", a => (a.data.key === "Fatal" ? 0.3 : 0.4))
              .attr("transform", a => arcTranslate(a))
              .attr("d", a => arcGen(a)),
            update => update
              .attr("fill", a => dotColor(a.data.key))
              .attr("opacity", a => (a.data.key === "Fatal" ? 1 : 0.82))
              .attr("stroke", a => (a.data.key === "Fatal" ? "#ffffff" : "#0b1f33"))
              .attr("stroke-opacity", a => (a.data.key === "Fatal" ? 0.9 : 0.55))
              .attr("stroke-width", a => (a.data.key === "Fatal" ? 0.3 : 0.4))
              .attr("transform", a => arcTranslate(a))
              .attr("d", a => arcGen(a)),
            exit => exit.remove()
          );

          // Hover hit-target for the whole pie (prevents flicker between slices)
          const hit = d3.select(this).selectAll("circle.pie-hit").data([d]);
          hit.join(
            enter => enter.append("circle")
              .attr("class", "pie-hit")
              .attr("r", radius + 6)
              .attr("fill", "transparent")
              .attr("pointer-events", "all")
              .on("mouseenter", (event) => tooltipShowPie(event, d))
              .on("mousemove", (event) => tooltipMove(event))
              .on("mouseleave", () => tooltipHide()),
            update => update
              .attr("r", radius + 6)
          );
        });

        return piesData.length > 0;
      }

      return {
        update(state) {
          lastState = state;
          const rows = filteredRows(state);
          currentRows = rows;

          // Inner borders are shown in BOTH views:
          // - DOTS: above points
          // - PIES: below pie charts
          gInnerBorders.attr("display", null);

          // Enforce layer order every update (switching views can change z-order).
          gLand.lower();
          gInnerBorders.raise();
          gPies.raise();
          gCoast.raise();

          if (state.mapView === "PIES") {
            // If geojson isn't ready yet, keep showing dots so the button doesn't look broken.
            if (!mapFeatures) {
              gPies.attr("display", "none");
              renderDots(rows);
              return;
            }

            gPies.attr("display", null);
            clearDots();
            const drewPies = renderPies(rows);
            // If, for any reason, no pies were drawn, fall back to dots so the view is never empty.
            if (!drewPies) {
              gPies.attr("display", "none");
              renderDots(rows);
            }
          } else {
            gPies.attr("display", "none");
            renderDots(rows);
          }
        }
      };
    }
  };

})();
