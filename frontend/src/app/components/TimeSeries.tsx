"use client";

import Plot from "react-plotly.js";

export default function TimeSeries({data}){

  if(!data) return null;

  return (
    <Plot
      data={[
        {
          x:data.time,
          y:data.values,
          type:"scatter",
          mode:"lines"
        }
      ]}
      layout={{title:"Climate Time Series"}}
    />
  );
}
