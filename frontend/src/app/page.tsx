"use client";

import {useState} from "react";
import MapView from "./components/MapView";
import Controls from "./components/Controls";

export default function Page(){

  const [variable,setVariable] = useState("t2m");
  const [time,setTime] = useState(0);

  return (
    <div style={{height:"100vh"}}>

      <Controls
        setVariable={setVariable}
        setTime={setTime}
      />

      <MapView
        variable={variable}
        time={time}
      />

    </div>
  )
}
