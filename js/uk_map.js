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
        monthIndex: d ? d.getMonth() : null
      };
    }).filter(d =>
      Number.isFinite(d.longitude) &&
      Number.isFinite(d.latitude) &&
      d.monthIndex !== null
    );
  }

  window.UKMapModule = {
    prepareRows,

    init({ slotSelector, preparedRows }) {
      // Coarse grid size in projected pixels; larger size = fewer pie charts (helps de-clutter London).
      const GRID_SIZE_PX = 48;

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

      // GeoJSON cached for drawing
      let mapFeatures = null;
      let lastState = { mode: "ALL", monthIndex: 0, mapView: "DOTS" };

      // Pre-project all points once; also bucket by month to avoid filtering 300k rows repeatedly.
      const rowsByMonth = Array.from({ length: 12 }, () => []);
      const allRows = preparedRows.map(r => {
        const [x, y] = projection([r.longitude, r.latitude]);
        const row = { ...r, x, y };
        rowsByMonth[row.monthIndex].push(row);
        return row;
      });

      // Radii chosen so Fatal > Serious > Slight for immediate visual priority.
      const dotBaseRadius = (d) => (d.severity === "Fatal") ? 3.6 : (d.severity === "Serious") ? 2.8 : 2.2;
      const dotBaseOpacity = (d) => (d.severity === "Fatal") ? 0.95 : (d.severity === "Serious") ? 0.88 : 0.6;
      const dotBaseStrokeWidth = 0.35;
      const dotStrokeColor = "#0b1f33";

      // Keep track of zoom so we can keep dots a constant on-screen size.
      let currentTransform = d3.zoomIdentity;
      let activeRows = allRows;
      let dotsVisible = false;

      function clearDots() {
        ctx.clearRect(0, 0, width, height);
        canvas.style("opacity", 0);
        dotsVisible = false;
      }

      function renderDots(rows) {
        activeRows = rows;
        canvas.style("opacity", 1);
        dotsVisible = true;

        ctx.clearRect(0, 0, width, height);

        const k = (currentTransform && currentTransform.k) ? currentTransform.k : 1;
        const invK = 1 / k;
        const strokeW = dotBaseStrokeWidth * invK;

        const severityGroups = { Fatal: [], Serious: [], Slight: [] };
        for (const r of rows) {
          if (severityGroups[r.severity]) severityGroups[r.severity].push(r);
        }

        ctx.save();
        ctx.translate(currentTransform.x, currentTransform.y);
        ctx.scale(k, k);
        ctx.lineWidth = strokeW;
        ctx.strokeStyle = dotStrokeColor;

        for (const sev of severityOrder) {
          const group = severityGroups[sev];
          if (!group.length) continue;
          ctx.fillStyle = dotColor(sev);
          ctx.globalAlpha = dotBaseOpacity({ severity: sev });

          for (const r of group) {
            const radius = dotBaseRadius(r) * invK;
            ctx.beginPath();
            ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
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
            renderDots(activeRows);
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
        return (state.mode === "MONTH")
          ? rowsByMonth[state.monthIndex] || []
          : allRows;
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
        const region = pie.topDistrict || "Unknown";
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

      function renderPies(rows) {
        // Bin accidents into a coarse projected grid to reduce overlap in dense areas (e.g., London).
        const binMap = new Map();

        for (const r of rows) {
          const x = r.x;
          const y = r.y;
          const gx = Math.round(x / GRID_SIZE_PX);
          const gy = Math.round(y / GRID_SIZE_PX);
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
          const topDistrict = districtsSorted.length ? districtsSorted[0][0] : "Unknown";
          const topDistricts = districtsSorted.slice(0, 3).map(([name, count]) => ({ name, count }));

          piesData.push({
            key: `${bucket.gx},${bucket.gy}`,
            cx,
            cy,
            Fatal: bucket.Fatal,
            Serious: bucket.Serious,
            Slight: bucket.Slight,
            total: bucket.total,
            topDistrict,
            topDistricts
          });
        }

        const radiusScale = d3.scaleSqrt()
          .domain([1, Math.max(1, maxTotal)])
          .range([7, 28]);

        const groups = gPies.selectAll("g.pie")
          .data(piesData, d => d.key);

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
              .attr("stroke-width", a => (a.data.key === "Fatal" ? 0.7 : 0.4))
              .attr("transform", a => arcTranslate(a))
              .attr("d", a => arcGen(a)),
            update => update
              .attr("fill", a => dotColor(a.data.key))
              .attr("opacity", a => (a.data.key === "Fatal" ? 1 : 0.82))
              .attr("stroke", a => (a.data.key === "Fatal" ? "#ffffff" : "#0b1f33"))
              .attr("stroke-opacity", a => (a.data.key === "Fatal" ? 0.9 : 0.55))
              .attr("stroke-width", a => (a.data.key === "Fatal" ? 0.7 : 0.4))
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

