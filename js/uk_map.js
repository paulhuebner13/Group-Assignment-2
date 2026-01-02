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
      const gPoints = gRoot.append("g");
      const gCoast = gRoot.append("g");

      const projection = d3.geoMercator()
        .center([-2, 54])
        .scale(2000)
        .translate([width / 2, height / 2]);

      const path = d3.geoPath().projection(projection);

      const severityColor = d3.scaleOrdinal()
        .domain(["Fatal", "Serious", "Slight"])
        .range(["#ff4b4b", "#ff9f1c", "#ffd166"]);

      // GeoJSON cached for drawing
      let mapFeatures = null;

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

        // Coastline contour ABOVE points
        gCoast.selectAll("path.coast-halo")
          .data(mapFeatures)
          .join("path")
          .attr("class", "coast-halo")
          .attr("d", path)
          .attr("fill", "none")
          .attr("stroke", "#ffffff")
          .attr("stroke-opacity", 0.5)
          .attr("stroke-width", 3)
          .attr("stroke-linejoin", "round")
          .attr("stroke-linecap", "round")
          .attr("vector-effect", "non-scaling-stroke");

        gCoast.selectAll("path.coastline")
          .data(mapFeatures)
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
      });

      function render(rows) {
        const sel = gPoints.selectAll("circle")
          .data(
            rows,
            d => `${d.longitude},${d.latitude},${d.monthIndex}` // stable key
          );

        sel.join(
          enter => enter.append("circle")
            .attr("r", 1.5)
            .attr("opacity", 0.5)
            .attr("fill", d => severityColor(d.severity))
            .attr("cx", d => projection([d.longitude, d.latitude])[0])
            .attr("cy", d => projection([d.longitude, d.latitude])[1]),

          update => update
            .attr("cx", d => projection([d.longitude, d.latitude])[0])
            .attr("cy", d => projection([d.longitude, d.latitude])[1]),

          exit => exit.remove()
        );
      }

      return {
        update(state) {
          const rows = (state.mode === "MONTH")
            ? preparedRows.filter(r => r.monthIndex === state.monthIndex)
            : preparedRows;
          render(rows);
        }
      };
    }
  };

})();
