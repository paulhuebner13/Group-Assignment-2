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

      const node = container.node();
      const width = node.clientWidth || 300;
      const height = node.clientHeight || 300;

      const svg = container.append("svg")
        .attr("width", width)
        .attr("height", height);

      // Background (ocean)
      svg.append("rect")
        .attr("width", width)
        .attr("height", height)
        .attr("fill", "#7fb7e6")
        .attr("fill-opacity", 0.7);

      // Transparent overlay to reliably capture pan/zoom interactions
      const overlay = svg.append("rect")
        .attr("width", width)
        .attr("height", height)
        .attr("fill", "transparent")
        .style("cursor", "grab");

      // Root group that will be transformed by zoom (contains map + points)
      const gRoot = svg.append("g");

      // Separate layers (VERY important)
      const gLand = gRoot.append("g");
      const gInnerBorders = gRoot.append("g");
      const gDots = gRoot.append("g");
      const gPies = gRoot.append("g");
      const gCoast = gRoot.append("g");

      const projection = d3.geoMercator()
        .center([-2, 54])
        .scale(2000)
        .translate([width / 2, height / 2]);

      const path = d3.geoPath().projection(projection);

      const severityOrder = ["Fatal", "Serious", "Slight"];

      const severityColor = d3.scaleOrdinal()
        .domain(severityOrder)
        .range(["#ff4b4b", "#ff9f1c", "#ffd166"]);

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

      // ---- Zoom & pan ----
      const zoom = d3.zoom()
        // Allow zooming out below the initial scale
        .scaleExtent([0.6, 10])
        .on("zoom", (event) => {
          gRoot.attr("transform", event.transform);
        });

      overlay.call(zoom);

      overlay
        .on("mousedown", () => overlay.style("cursor", "grabbing"))
        .on("mouseup", () => overlay.style("cursor", "grab"))
        .on("mouseleave", () => overlay.style("cursor", "grab"));

      // Keep the overlay above the map so zoom/pan works anywhere.
      overlay.raise();

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
          ? preparedRows.filter(r => r.monthIndex === state.monthIndex)
          : preparedRows;
      }

      function renderDots(rows) {
        const sel = gDots.selectAll("circle")
          .data(
            rows,
            d => `${d.longitude},${d.latitude},${d.monthIndex}` // stable key
          );

        sel.join(
          enter => enter.append("circle")
            .attr("r", d => (d.severity === "Fatal") ? 2.4 : (d.severity === "Serious") ? 2.1 : 1.7)
            .attr("opacity", d => (d.severity === "Fatal") ? 0.9 : (d.severity === "Serious") ? 0.85 : 0.55)
            .attr("fill", d => dotColor(d.severity))
            .attr("stroke", "#0b1f33")
            .attr("stroke-opacity", 0.35)
            .attr("stroke-width", 0.35)
            .attr("cx", d => projection([d.longitude, d.latitude])[0])
            .attr("cy", d => projection([d.longitude, d.latitude])[1]),

          update => update
            .attr("r", d => (d.severity === "Fatal") ? 2.4 : (d.severity === "Serious") ? 2.1 : 1.7)
            .attr("opacity", d => (d.severity === "Fatal") ? 0.9 : (d.severity === "Serious") ? 0.85 : 0.55)
            .attr("fill", d => dotColor(d.severity))
            .attr("cx", d => projection([d.longitude, d.latitude])[0])
            .attr("cy", d => projection([d.longitude, d.latitude])[1]),

          exit => exit.remove()
        );
      }

      function renderPies(rows) {
        // Bin accidents into a coarse projected grid to reduce overlap in dense areas (e.g., London).
        const binMap = new Map();

        for (const r of rows) {
          const [x, y] = projection([r.longitude, r.latitude]);
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
              total: 0
            };
            binMap.set(key, bucket);
          }

          bucket.sumX += x;
          bucket.sumY += y;
          if (bucket[r.severity] !== undefined) bucket[r.severity] += 1;
          bucket.total += 1;
        }

        const piesData = [];
        let maxTotal = 0;

        for (const bucket of binMap.values()) {
          if (bucket.total <= 0) continue;
          maxTotal = Math.max(maxTotal, bucket.total);
          const cx = bucket.sumX / bucket.total;
          const cy = bucket.sumY / bucket.total;

          piesData.push({
            key: `${bucket.gx},${bucket.gy}`,
            cx,
            cy,
            Fatal: bucket.Fatal,
            Serious: bucket.Serious,
            Slight: bucket.Slight,
            total: bucket.total
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

          const arcGen = d3.arc()
            .innerRadius(0)
            .outerRadius(radius);

          const sel = d3.select(this).selectAll("path")
            .data(arcs, a => a.data.key);

          sel.join(
            enter => enter.append("path")
              .attr("fill", a => dotColor(a.data.key))
              .attr("opacity", 0.85)
              .attr("stroke", "#0b1f33")
              .attr("stroke-width", 0.4)
              .attr("d", arcGen),
            update => update
              .attr("fill", a => dotColor(a.data.key))
              .attr("d", arcGen),
            exit => exit.remove()
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
          if (state.mapView === "DOTS") {
            gDots.raise();
            gInnerBorders.raise();
          } else {
            gPies.raise();
          }
          gCoast.raise();

          if (state.mapView === "PIES") {
            // If geojson isn't ready yet, keep showing dots so the button doesn't look broken.
            if (!mapFeatures) {
              gPies.attr("display", "none");
              gDots.attr("display", null);
              renderDots(rows);
              return;
            }

            gDots.attr("display", "none");
            gPies.attr("display", null);
            gDots.selectAll("circle").remove();
            const drewPies = renderPies(rows);
            // If, for any reason, no pies were drawn, fall back to dots so the view is never empty.
            if (!drewPies) {
              gPies.attr("display", "none");
              gDots.attr("display", null);
              renderDots(rows);
            }
          } else {
            gPies.attr("display", "none");
            gDots.attr("display", null);
            gPies.selectAll("g.pie").remove();
            renderDots(rows);
          }
        }
      };
    }
  };

})();
