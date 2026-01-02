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

      // Separate layers (VERY important)
      const gMap = svg.append("g");
      const gPoints = svg.append("g");

      const projection = d3.geoMercator()
        .center([-2, 54])
        .scale(2000)
        .translate([width / 2, height / 2]);

      const path = d3.geoPath().projection(projection);

      const severityColor = d3.scaleOrdinal()
        .domain(["Fatal", "Serious", "Slight"])
        .range(["#ff4b4b", "#ff9f1c", "#ffd166"]);

      // ---- Draw base map ONCE ----
      d3.json("data/gb.json").then(geojson => {
        gMap.selectAll("path")
          .data(geojson.features)
          .join("path")
          .attr("d", path)
          .attr("fill", "#2d2d2d")
          .attr("stroke", "#555")
          .attr("stroke-width", 0.5);
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
