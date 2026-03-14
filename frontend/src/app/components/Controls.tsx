"use client";

import {useEffect,useState} from "react";
import {getVariables} from "../api";

export default function Controls({setVariable,setTime}){

  const [vars,setVars] = useState([]);

  useEffect(()=>{
    async function load(){
      const v = await getVariables();
      setVars(v.variables);
    }
    load();
  },[])

  return (
    <div style={{padding:20}}>

      <select onChange={e=>setVariable(e.target.value)}>
        {vars.map(v=>(
          <option key={v}>{v}</option>
        ))}
      </select>

      <input
        type="range"
        min="0"
        max="100"
        onChange={e=>setTime(parseInt(e.target.value))}
      />

    </div>
  )
}
