"use client";

import { useEffect, useState } from "react";
import DeckGL from "@deck.gl/react";
import { HeatmapLayer } from "@deck.gl/aggregation-layers";
import { Map } from "react-map-gl/maplibre";
import dynamic from "next/dynamic";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

const API = "http://localhost:8000";

export default function Page() {

  const [variables, setVariables] = useState<string[]>([]);
  const [variable, setVariable] = useState("");
  const [year, setYear] = useState(2022);
  const [month, setMonth] = useState(1);
  const [day, setDay] = useState(1);
  const [hour, setHour] = useState(0);

  const [mapData, setMapData] = useState<any[]>([]);
  const [series, setSeries] = useState<any>(null);

  const [viewState, setViewState] = useState({
    longitude: 0,
    latitude: 20,
    zoom: 2,
    pitch: 0,
    bearing: 0
  });

  // --------------------------
  // load variables
  // --------------------------

  useEffect(() => {
    fetch(`${API}/variables`)
      .then(r => r.json())
      .then(d => {
        setVariables(d.variables);
        if (d.variables.length > 0) setVariable(d.variables[0]);
      });
  }, []);

  // --------------------------
  // load tile
  // --------------------------

  async function loadTile() {

    const res = await fetch(`${API}/tile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        variable,
        year,
        month,
        day,
        hour,
        lat_min: -90,
        lat_max: 90,
        lon_min: -180,
        lon_max: 180
      })
    });

    const tile = await res.json();

    const points: any[] = [];

    for (let i = 0; i < tile.lat.length; i++) {
      for (let j = 0; j < tile.lon.length; j++) {
        points.push({
          position: [tile.lon[j], tile.lat[i]],
          value: tile.values[i][j]
        });
      }
    }

    setMapData(points);
  }

  useEffect(() => {
    if (variable) loadTile();
  }, [variable, year, month, day, hour]);

  // --------------------------
  // click → timeseries
  // --------------------------

  async function fetchSeries(lon: number, lat: number) {

    const res = await fetch(`${API}/timeseries`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        variable,
        lat,
        lon
      })
    });

    const data = await res.json();
    setSeries(data);
  }

  // --------------------------
  // deck layer
  // --------------------------

  const heatLayer = new HeatmapLayer({
    id: "heatmap",
    data: mapData,
    getPosition: (d: any) => d.position,
    getWeight: (d: any) => d.value,
    radiusPixels: 50
  });

  // --------------------------
  // render
  // --------------------------

  return (
    <div style={{ display: "flex", height: "100vh" }}>

      {/* LEFT PANEL */}

      <div style={{ width: 320, padding: 20, background: "#111", color: "white" }}>

        <h2>Climate Explorer</h2>

        <div>
          <label>Variable</label>
          <select
            style={{ width: "100%" }}
            value={variable}
            onChange={(e) => setVariable(e.target.value)}
          >
            {variables.map(v => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </div>

        <br />

        <div>
          <label>Year</label>
          <input
            type="number"
            value={year}
            onChange={e => setYear(parseInt(e.target.value))}
          />
        </div>

        <div>
          <label>Month</label>
          <input
            type="number"
            min={1}
            max={12}
            value={month}
            onChange={e => setMonth(parseInt(e.target.value))}
          />
        </div>

        <div>
          <label>Day</label>
          <input
            type="number"
            value={day}
            onChange={e => setDay(parseInt(e.target.value))}
          />
        </div>

        <div>
          <label>Hour</label>
          <input
            type="number"
            step={6}
            value={hour}
            onChange={e => setHour(parseInt(e.target.value))}
          />
        </div>

      </div>

      {/* MAP */}

      <div style={{ flex: 1 }}>

        <DeckGL
          viewState={viewState}
          controller={true}
          layers={[heatLayer]}
          onViewStateChange={(e) => setViewState(e.viewState)}
          onClick={(info) => {
            if (info.coordinate) {
              const [lon, lat] = info.coordinate;
              fetchSeries(lon, lat);
            }
          }}
        >

          <Map
            mapStyle="https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
          />

        </DeckGL>

      </div>

      {/* TIMESERIES */}

      {series && (

        <div style={{ width: 400, padding: 20, background: "#fff" }}>

          <Plot
            data={[
              {
                x: series.time,
                y: series.values,
                type: "scatter",
                mode: "lines"
              }
            ]}
            layout={{
              title: "Time Series",
              width: 380,
              height: 300
            }}
          />

        </div>

      )}

    </div>
  );
}
