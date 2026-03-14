"use client";

import DeckGL from "@deck.gl/react";
import {HeatmapLayer} from "@deck.gl/aggregation-layers";
import {Map} from "react-map-gl";
import {useEffect, useState} from "react";
import {getTile} from "../api";

export default function MapView({variable,time}) {

  const [data,setData] = useState([]);

  async function loadTile(){

    const tile = await getTile({
      variable,
      time_index: time,
      lat_min: -90,
      lat_max: 90,
      lon_min: -180,
      lon_max: 180
    });

    const points = [];

    for(let i=0;i<tile.lat.length;i++){
      for(let j=0;j<tile.lon.length;j++){

        points.push({
          position:[tile.lon[j],tile.lat[i]],
          value: tile.values[i][j]
        });

      }
    }

    setData(points);
  }

  useEffect(()=>{
    loadTile();
  },[variable,time]);

  const layer = new HeatmapLayer({
    id:"heatmap",
    data,
    getPosition: d=>d.position,
    getWeight: d=>d.value,
    radiusPixels:40
  });

  return (
    <DeckGL
      initialViewState={{
        longitude:0,
        latitude:20,
        zoom:2
      }}
      controller
      layers={[layer]}
    >
      <Map
        mapStyle="https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
      />
    </DeckGL>
  );
}
