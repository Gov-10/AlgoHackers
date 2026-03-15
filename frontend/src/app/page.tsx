"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import DeckGL from "@deck.gl/react";
import { HeatmapLayer } from "@deck.gl/aggregation-layers";
import { ScatterplotLayer } from "@deck.gl/layers";
import { Map } from "react-map-gl/maplibre";
import dynamic from "next/dynamic";
const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

const API = "https://omyrbh426k.execute-api.ap-south-1.amazonaws.com";

// Types
type ViewMode = "heatmap" | "3d" | "compare" | "wind" | "anomaly";
interface MapPoint       { position: [number, number]; value: number; }
interface ClickedPoint   { lat: number; lon: number; }
interface TimeSeriesData { time: string[]; values: number[]; }
interface CompareTime    { year: number; month: number; day: number; hour: number; }
interface Metadata {
  variables: string[];
  years: number[];
  lat_range: [number, number];
  lon_range: [number, number];
}

// Helpers
const pad = (n: number) => String(n).padStart(2, "0");
function calcStats(points: MapPoint[]) {
  if (!points.length) return null;
  const vals = points.map(p => p.value).filter(v => isFinite(v));
  if (!vals.length) return null;
  const min  = Math.min(...vals);
  const max  = Math.max(...vals);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { min, max, mean };
}
function flattenTile(tile: { lat: number[]; lon: number[]; values: number[][] }): MapPoint[] {
  const pts: MapPoint[] = [];
  for (let i = 0; i < tile.lat.length; i++)
    for (let j = 0; j < tile.lon.length; j++) {
      const v = tile.values[i][j];
      if (isFinite(v)) pts.push({ position: [tile.lon[j], tile.lat[i]], value: v });
    }
  return pts;
}
function flattenDiff(tile: { lat: number[]; lon: number[]; diff: number[][] }): MapPoint[] {
  const pts: MapPoint[] = [];
  for (let i = 0; i < tile.lat.length; i++)
    for (let j = 0; j < tile.lon.length; j++) {
      const v = tile.diff[i][j];
      if (isFinite(v)) pts.push({ position: [tile.lon[j], tile.lat[i]], value: v });
    }
  return pts;
}

// Design tokens
const C = {
  bg:       "#0c0e14",
  surface:  "#111520",
  border:   "rgba(148,130,255,0.12)",
  borderHi: "rgba(148,130,255,0.38)",
  accent:   "#9482ff",
  accentLo: "rgba(148,130,255,0.07)",
  accentMd: "rgba(148,130,255,0.18)",
  gold:     "#f0b429",
  goldLo:   "rgba(240,180,41,0.08)",
  text:     "#d4cfff",
  textMid:  "#6b658f",
  textDim:  "#35304f",
  danger:   "#ff6b6b",
};
const FM = "'JetBrains Mono','Fira Code',monospace";
const FS = "'Plus Jakarta Sans',system-ui,sans-serif";

// Globe View - isolated WebGL context, raycasting for inspect clicks
function GlobeView({
  mapData, stats, isDiff, inspectMode, onGlobeClick,
}: {
  mapData: MapPoint[];
  stats: { min: number; max: number; mean: number } | null;
  isDiff: boolean;
  inspectMode: boolean;
  onGlobeClick: (lon: number, lat: number) => void;
}) {
  const mountRef   = useRef<HTMLDivElement>(null);
  const apiRef     = useRef<{ rebuild: (p: MapPoint[], s: typeof stats) => void } | null>(null);
  // Refs so the long-lived async closure always reads the latest values
  const inspectRef = useRef(inspectMode);
  const clickRef   = useRef(onGlobeClick);
  useEffect(() => { inspectRef.current = inspectMode; },   [inspectMode]);
  useEffect(() => { clickRef.current   = onGlobeClick; }, [onGlobeClick]);

  // Mount once - sets up Three.js scene
  useEffect(() => {
    if (!mountRef.current) return;
    let raf: number, destroyed = false;
    let _renderer: any, _scene: any, _camera: any, _raycaster: any;
    let _globe: any, _clouds: any, _stars: any, _dataPts: any;
    let rotX = 0.25, rotY = 0;
    let dragging = false, dragMoved = false;
    let mouseDownPos = { x: 0, y: 0 };
    let lastMouse = { x: 0, y: 0 };
    let autoSpin = true;

    (async () => {
      const THREE = await import("three");
      if (destroyed || !mountRef.current) return;

      const W = mountRef.current.clientWidth  || 800;
      const H = mountRef.current.clientHeight || 600;

      // Own canvas + forced WebGL2 - never touches Deck.gl's WebGPU context
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab;touch-action:none";

      const ctxOpts = { alpha: true, antialias: true, powerPreference: "high-performance" as const };
      const gl = (canvas.getContext("webgl2", ctxOpts) ??
                  canvas.getContext("webgl",  ctxOpts)) as WebGLRenderingContext;
      if (!gl) {
        if (mountRef.current)
          mountRef.current.innerHTML = `<div style="color:#ff6b6b;padding:30px;font-family:monospace;font-size:13px">WebGL unavailable.</div>`;
        return;
      }

      _renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true, alpha: true });
      _renderer.setSize(W, H, false);
      _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      _renderer.setClearColor(0x000000, 0);
      mountRef.current.appendChild(canvas);

      _scene    = new THREE.Scene();
      _camera   = new THREE.PerspectiveCamera(42, W / H, 0.1, 1000);
      _camera.position.z = 2.7;
      _raycaster = new THREE.Raycaster();

      // Stars
      const starBuf = new Float32Array(4000 * 3);
      for (let i = 0; i < starBuf.length; i++) starBuf[i] = (Math.random() - 0.5) * 300;
      const starGeo = new THREE.BufferGeometry();
      starGeo.setAttribute("position", new THREE.BufferAttribute(starBuf, 3));
      _stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
        color: 0xffffff, size: 0.15, transparent: true, opacity: 0.5,
      }));
      _scene.add(_stars);

      // Procedural fallback Earth texture
      const makeProc = () => {
        const c = document.createElement("canvas"); c.width = 1024; c.height = 512;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#0a1a3a"; ctx.fillRect(0, 0, 1024, 512);
        const g = ctx.createLinearGradient(0, 0, 0, 512);
        g.addColorStop(0,    "#0a2060"); g.addColorStop(0.15, "#0d2e5a");
        g.addColorStop(0.3,  "#1a5c30"); g.addColorStop(0.5,  "#1a7a30");
        g.addColorStop(0.7,  "#1a5c30"); g.addColorStop(0.85, "#0d2e5a");
        g.addColorStop(1,    "#0a2060");
        ctx.fillStyle = g; ctx.fillRect(0, 0, 1024, 512);
        return new THREE.CanvasTexture(c);
      };

      const loader = new THREE.TextureLoader();
      loader.crossOrigin = "anonymous";
      const earthTex = loader.load(
        "https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg",
        undefined, undefined,
        () => { if (_globe) { _globe.material.map = makeProc(); _globe.material.needsUpdate = true; } }
      );
      _globe = new THREE.Mesh(
        new THREE.SphereGeometry(1, 72, 72),
        new THREE.MeshPhongMaterial({ map: earthTex, specular: new THREE.Color(0x223366), shininess: 18 })
      );
      _scene.add(_globe);

      // Clouds
      const cloudTex = loader.load("https://unpkg.com/three-globe/example/img/earth-clouds.png");
      _clouds = new THREE.Mesh(
        new THREE.SphereGeometry(1.009, 72, 72),
        new THREE.MeshPhongMaterial({ map: cloudTex, transparent: true, opacity: 0.28, depthWrite: false })
      );
      _scene.add(_clouds);

      // Atmosphere glow
      _scene.add(new THREE.Mesh(
        new THREE.SphereGeometry(1.2, 64, 64),
        new THREE.ShaderMaterial({
          vertexShader:   `varying vec3 vN;void main(){vN=normalize(normalMatrix*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
          fragmentShader: `varying vec3 vN;void main(){float i=pow(.62-dot(vN,vec3(0,0,1)),4.);gl_FragColor=vec4(.36,.3,1.,1.)*i;}`,
          blending: THREE.AdditiveBlending, side: THREE.BackSide, transparent: true,
        })
      ));

      // Lat/lon grid lines
      const gridMat = new THREE.LineBasicMaterial({ color: 0x9482ff, transparent: true, opacity: 0.07 });
      for (let lat = -75; lat <= 75; lat += 15) {
        const pts: any[] = [];
        for (let lon = 0; lon <= 360; lon += 4) {
          const phi = (90 - lat) * Math.PI / 180, theta = lon * Math.PI / 180;
          pts.push(new THREE.Vector3(1.002*Math.sin(phi)*Math.cos(theta), 1.002*Math.cos(phi), 1.002*Math.sin(phi)*Math.sin(theta)));
        }
        _scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gridMat));
      }
      for (let lon = 0; lon < 360; lon += 20) {
        const pts: any[] = [];
        for (let lat = -90; lat <= 90; lat += 4) {
          const phi = (90 - lat) * Math.PI / 180, theta = lon * Math.PI / 180;
          pts.push(new THREE.Vector3(1.002*Math.sin(phi)*Math.cos(theta), 1.002*Math.cos(phi), 1.002*Math.sin(phi)*Math.sin(theta)));
        }
        _scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gridMat));
      }

      // Lights
      _scene.add(new THREE.AmbientLight(0x2a2050, 0.9));
      const sun = new THREE.DirectionalLight(0xfff0e0, 1.6); sun.position.set(6, 3, 5); _scene.add(sun);
      const rim = new THREE.DirectionalLight(0x3020aa, 0.5); rim.position.set(-5, -2, -4); _scene.add(rim);

      // Data point builder
      function rebuild(pts: MapPoint[], s: typeof stats) {
        if (_dataPts) {
          _scene.remove(_dataPts);
          _dataPts.geometry.dispose();
          _dataPts.material.dispose();
          _dataPts = null;
        }
        if (!pts.length) return;
        const step = Math.ceil(pts.length / 5000);
        const sub  = pts.filter((_, i) => i % step === 0);
        const mn   = s?.min ?? 0, mx = s?.max ?? 1, rng = mx - mn || 1;
        const pos: number[] = [], col: number[] = [], sz: number[] = [];
        sub.forEach(({ position: [lon, lat], value }) => {
          const phi   = (90 - lat) * Math.PI / 180;
          const theta = (lon + 180) * Math.PI / 180;
          const r = 1.013;
          pos.push(r*Math.sin(phi)*Math.cos(theta), r*Math.cos(phi), r*Math.sin(phi)*Math.sin(theta));
          const t = (value - mn) / rng;
          if (isDiff) {
            col.push(t < 0.5 ? 0 : (t-.5)*2, 0.05, t > 0.5 ? 0 : (.5-t)*2);
          } else {
            if      (t < 0.33) col.push(.36*t*3,             .18*t*3,             1 - t*1.5);
            else if (t < 0.66) col.push(.36 + .6*(t-.33)*3,  .18 + .5*(t-.33)*3, .5 - .5*(t-.33)*3);
            else               col.push(.94,                  .7 - .4*(t-.66)*3,  .16 - .16*(t-.66)*3);
          }
          sz.push(2 + t * 4);
        });
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
        geo.setAttribute("color",    new THREE.BufferAttribute(new Float32Array(col), 3));
        geo.setAttribute("size",     new THREE.BufferAttribute(new Float32Array(sz),  1));
        _dataPts = new THREE.Points(geo, new THREE.ShaderMaterial({
          vertexShader: `
            attribute float size; attribute vec3 color; varying vec3 vC;
            void main(){
              vC=color;
              vec4 mv=modelViewMatrix*vec4(position,1.);
              gl_PointSize=size*(280./-mv.z);
              gl_Position=projectionMatrix*mv;
            }`,
          fragmentShader: `
            varying vec3 vC;
            void main(){
              float d=length(gl_PointCoord-.5);
              if(d>.5) discard;
              gl_FragColor=vec4(vC,smoothstep(.5,.05,d)*.88);
            }`,
          transparent: true, blending: THREE.AdditiveBlending,
          depthWrite: false, vertexColors: true,
        }));
        _scene.add(_dataPts);
      }

      rebuild(mapData, stats);
      apiRef.current = { rebuild };

      // Helper: convert globe surface hit point -> lat/lon accounting for current rotation
      function hitToLatLon(point: any): { lat: number; lon: number } {
        // The globe is rotated by rotX/rotY, so we need to un-rotate the hit point
        const inv = new THREE.Euler(-rotX, -rotY, 0, "YXZ");
        const local = point.clone().applyEuler(inv).normalize();
        const lat = Math.asin(local.y) * (180 / Math.PI);
        const lon = Math.atan2(local.z, local.x) * (180 / Math.PI) - 90;
        return { lat, lon: ((lon % 360) + 540) % 360 - 180 };
      }

      // Mouse events
      const onDown = (e: MouseEvent) => {
        dragging = true;
        dragMoved = false;
        autoSpin = false;
        mouseDownPos = { x: e.clientX, y: e.clientY };
        lastMouse    = { x: e.clientX, y: e.clientY };
        canvas.style.cursor = "grabbing";
      };

      const onUp = (e: MouseEvent) => {
        if (!dragging) return;
        dragging = false;
        canvas.style.cursor = inspectRef.current ? "crosshair" : "grab";

        // Only fire a click if mouse barely moved (not a drag)
        const dx = e.clientX - mouseDownPos.x;
        const dy = e.clientY - mouseDownPos.y;
        if (Math.sqrt(dx*dx + dy*dy) > 5) return;
        if (!inspectRef.current) return;

        // Raycast against the globe sphere
        const rect = canvas.getBoundingClientRect();
        const ndc = new THREE.Vector2(
          ((e.clientX - rect.left)  / rect.width)  * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1
        );
        _raycaster.setFromCamera(ndc, _camera);
        const hits = _raycaster.intersectObject(_globe);
        if (hits.length === 0) return;

        const { lat, lon } = hitToLatLon(hits[0].point);
        clickRef.current(lon, lat);
      };

      const onMove = (e: MouseEvent) => {
        if (!dragging) {
          canvas.style.cursor = inspectRef.current ? "crosshair" : "grab";
          return;
        }
        const dx = e.clientX - lastMouse.x;
        const dy = e.clientY - lastMouse.y;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved = true;
        rotY += dx * 0.005;
        rotX += dy * 0.005;
        rotX  = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, rotX));
        lastMouse = { x: e.clientX, y: e.clientY };
      };

      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        _camera.position.z = Math.max(1.4, Math.min(6, _camera.position.z + e.deltaY * 0.003));
      };

      canvas.addEventListener("mousedown", onDown);
      canvas.addEventListener("mouseup",   onUp);
      window.addEventListener("mousemove", onMove);
      canvas.addEventListener("wheel", onWheel, { passive: false });

      // Resize
      const onResize = () => {
        if (!mountRef.current || destroyed) return;
        const w = mountRef.current.clientWidth, h = mountRef.current.clientHeight;
        _camera.aspect = w / h; _camera.updateProjectionMatrix();
        _renderer.setSize(w, h, false);
      };
      window.addEventListener("resize", onResize);

      // Render loop
      let elapsed = 0, last = performance.now();
      const tick = (now: number) => {
        if (destroyed) return;
        raf = requestAnimationFrame(tick);
        const dt = Math.min((now - last) / 1000, 0.05); last = now; elapsed += dt;
        if (autoSpin) rotY += dt * 0.055;
        _globe.rotation.set(rotX, rotY, 0);
        if (_dataPts) _dataPts.rotation.set(rotX, rotY, 0);
        _clouds.rotation.set(rotX, rotY + elapsed * 0.007, 0);
        _stars.rotation.y += dt * 0.002;
        _renderer.render(_scene, _camera);
      };
      raf = requestAnimationFrame(tick);

      (apiRef as any)._cleanup = () => {
        destroyed = true;
        cancelAnimationFrame(raf);
        canvas.removeEventListener("mousedown", onDown);
        canvas.removeEventListener("mouseup",   onUp);
        window.removeEventListener("mousemove", onMove);
        canvas.removeEventListener("wheel", onWheel);
        window.removeEventListener("resize", onResize);
        _renderer.dispose();
        canvas.parentNode?.removeChild(canvas);
      };
    })();

    return () => {
      destroyed = true;
      cancelAnimationFrame(raf!);
      (apiRef as any)._cleanup?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reactively update data points without remounting
  useEffect(() => {
    apiRef.current?.rebuild(mapData, stats);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapData, stats, isDiff]);

  return (
    <div ref={mountRef} style={{
      position: "absolute", inset: 0,
      background: "radial-gradient(ellipse at 35% 40%, #0d0a22 0%, #06080f 100%)",
    }}>
      <div style={{
        position: "absolute", top: 14, right: 14, zIndex: 5, pointerEvents: "none",
        fontSize: 10, color: "rgba(148,130,255,0.35)", fontFamily: FM, letterSpacing: 1,
        background: "rgba(0,0,0,.55)", padding: "5px 12px", borderRadius: 6,
        border: "1px solid rgba(148,130,255,0.08)",
      }}>
        {inspectMode ? "CLICK GLOBE TO INSPECT" : "DRAG · ROTATE  |  SCROLL · ZOOM"}
      </div>
    </div>
  );
}

// Shared UI atoms
function StatCard({ label, value }: { label: string; value: number | null }) {
  return (
    <div style={{
      background: C.accentLo, border: `1px solid ${C.border}`,
      borderRadius: 10, padding: "9px 12px", flex: 1, minWidth: 0,
      position: "relative", overflow: "hidden",
    }}>
      <div style={{ position:"absolute",top:0,left:"20%",right:"20%",height:1,background:`linear-gradient(90deg,transparent,${C.accent},transparent)` }}/>
      <div style={{ fontSize:9, color:C.textDim, textTransform:"uppercase", letterSpacing:1.8, marginBottom:4, fontFamily:FM }}>{label}</div>
      <div style={{ fontSize:15, fontWeight:600, color:C.text, fontVariantNumeric:"tabular-nums", fontFamily:FM }}>
        {value != null ? value.toFixed(2) : "—"}
      </div>
    </div>
  );
}

function Section({ title, children, last }: { title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div style={{ padding:"12px 16px", borderBottom: last ? "none" : `1px solid ${C.border}` }}>
      <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:10,fontSize:9,color:C.textDim,textTransform:"uppercase",letterSpacing:2.5,fontWeight:700,fontFamily:FM }}>
        <span style={{ width:12,height:1,background:C.border,display:"inline-block" }}/>
        {title}
        <span style={{ flex:1,height:1,background:`linear-gradient(to right,${C.border},transparent)`,display:"inline-block" }}/>
      </div>
      {children}
    </div>
  );
}

function speakSummary(text: string) {
  if (!("speechSynthesis" in window)) return;

  const synth = window.speechSynthesis;

  const speak = () => {
    const voices = synth.getVoices();

    const voice =
      voices.find(v => v.name.includes("Google US English")) ||
      voices.find(v => v.name.includes("Microsoft Aria")) ||
      voices.find(v => v.name.includes("Microsoft Jenny")) ||
      voices.find(v => v.lang === "en-US") ||
      voices[0];

    const sentences = text
      .replace(/\n/g, " ")
      .split(/(?<=[.?!])\s+/);

    synth.cancel();

    sentences.forEach((sentence, i) => {
      const utter = new SpeechSynthesisUtterance(sentence.trim());

      if (voice) utter.voice = voice;

      utter.rate = 1;
      utter.pitch = 1;
      utter.volume = 1;

      // slight delay between sentences
      utter.onend = () => {
        if (i < sentences.length - 1) {
          setTimeout(() => {}, 120);
        }
      };

      synth.speak(utter);
    });
  };

  if (synth.getVoices().length === 0) {
    synth.onvoiceschanged = speak;
  } else {
    speak();
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom:7 }}>
      <div style={{ fontSize:10,color:C.textDim,marginBottom:3,fontFamily:FM,letterSpacing:.5 }}>{label}</div>
      {children}
    </div>
  );
}

const iStyle: React.CSSProperties = {
  width:"100%", boxSizing:"border-box",
  background:"rgba(0,0,0,0.4)", border:`1px solid ${C.border}`,
  borderRadius:7, color:C.text, padding:"7px 10px",
  fontSize:12, outline:"none", fontFamily:FM, transition:"border-color 0.18s",
};

function MBtn({ active, onClick, icon, label }: { active:boolean; onClick:()=>void; icon:string; label:string }) {
  return (
    <button onClick={onClick} style={{
      flex:1, padding:"8px 3px",
      background: active ? C.accentMd : "rgba(0,0,0,0.25)",
      border:`1px solid ${active ? C.borderHi : C.border}`,
      borderRadius:8, color: active ? C.accent : C.textDim,
      cursor:"pointer", fontSize:10, fontFamily:FM, letterSpacing:.5,
      display:"flex", flexDirection:"column", alignItems:"center", gap:3,
      transition:"all 0.18s",
      boxShadow: active ? `0 0 16px rgba(148,130,255,.18),inset 0 1px 0 rgba(148,130,255,.2)` : "none",
    }}>
      <span style={{ fontSize:16 }}>{icon}</span>{label}
    </button>
  );
}

function AISummary({ summary, loading, onRefresh }: { summary:string|null; loading:boolean; onRefresh:()=>void }) {
  return (
    <div style={{
      margin:"10px 14px",
      background:`linear-gradient(135deg,rgba(148,130,255,.05),rgba(240,180,41,.03))`,
      border:`1px solid ${C.border}`, borderRadius:12, padding:"12px 14px", minHeight:70,
      position:"relative", overflow:"hidden",
    }}>
      <div style={{ position:"absolute",top:0,left:"15%",right:"15%",height:1,background:`linear-gradient(90deg,transparent,${C.accent},transparent)` }}/>
      <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:9 }}>
        <div style={{ fontSize:9,color:C.textDim,letterSpacing:2,fontFamily:FM,textTransform:"uppercase",display:"flex",alignItems:"center",gap:6 }}>
          <span>✦</span> AI ANALYSIS
        </div>
        <button onClick={onRefresh} disabled={loading} style={{
          background: loading ? "none" : C.accentLo, border:`1px solid ${C.border}`,
          borderRadius:6, color: loading ? C.textDim : C.accent,
          fontSize:10, cursor: loading ? "default" : "pointer",
          padding:"3px 10px", fontFamily:FM, transition:"all 0.18s",
        }}>
          {loading ? "···" : "↺ refresh"}
        </button>
      </div>
      {loading ? (
        <div style={{ display:"flex",alignItems:"center",gap:8 }}>
          {[0,1,2].map(i => (
            <div key={i} style={{ width:5,height:5,borderRadius:"50%",background:C.accent,animation:`pulse 1.4s ease-in-out ${i*.22}s infinite` }}/>
          ))}
          <span style={{ fontSize:11,color:C.textDim,fontFamily:FM }}>analysing…</span>
        </div>
      ) : summary ? (
        <p style={{ fontSize:12,color:C.text,lineHeight:1.75,margin:0,maxHeight:130,overflowY:"auto",paddingRight:4,wordBreak:"break-word",fontFamily:FS,animation:"fadeUp 0.3s ease" }}>
          {summary}
        </p>
      ) : (
        <p style={{ fontSize:11,color:C.textDim,margin:0,fontStyle:"italic",fontFamily:FM,lineHeight:1.7 }}>
          press ↺ refresh for an AI explanation
        </p>
      )}
    </div>
  );
}

// Main Page
export default function Page() {
  const [metadata, setMetadata]             = useState<Metadata | null>(null);
  const [variable, setVariable]             = useState("");
  const [year,  setYear]                    = useState(2022);
  const [month, setMonth]                   = useState(1);
  const [day,   setDay]                     = useState(1);
  const [hour,  setHour]                    = useState(0);
  const [viewMode, setViewMode]             = useState<ViewMode>("heatmap");
  const [inspectMode, setInspectMode]       = useState(false);
  const [playing, setPlaying]               = useState(false);
  const [viewState, setViewState]           = useState({ longitude:0, latitude:20, zoom:2, pitch:0, bearing:0 });
  const [mapData, setMapData]               = useState<MapPoint[]>([]);
  const [loading, setLoading]               = useState(false);
  const [error,  setError]                  = useState<string | null>(null);
  const [stats,  setStats]                  = useState<{ min:number; max:number; mean:number } | null>(null);
  const [series, setSeries]                 = useState<TimeSeriesData | null>(null);
  const [clicked, setClicked]               = useState<ClickedPoint | null>(null);
  const [seriesLoading, setSeriesLoading]   = useState(false);
  const [compareA, setCompareA]             = useState<CompareTime>({ year:2020, month:1, day:1, hour:0 });
  const [compareB, setCompareB]             = useState<CompareTime>({ year:2022, month:1, day:1, hour:0 });
  const [summary, setSummary]               = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const playRef = useRef(playing); playRef.current = playing;

  // Data callbacks
  const loadTile = useCallback(async () => {
    if (!variable) return;
    setLoading(true); setError(null);
    try {
      if (viewMode === "anomaly") {
        const res = await fetch(`${API}/anomaly?variable=${variable}&year=${year}&month=${month}&day=${day}&hour=${hour}`);
        if (!res.ok) throw new Error(`Server ${res.status}`);
        const tile = await res.json(); const pts = flattenTile(tile);
        setMapData(pts); setStats(calcStats(pts)); return;
      }
      if (viewMode === "compare") {
        const res = await fetch(`${API}/compare`, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({
            variable,
            year_a:compareA.year, month_a:compareA.month, day_a:compareA.day, hour_a:compareA.hour,
            year_b:compareB.year, month_b:compareB.month, day_b:compareB.day, hour_b:compareB.hour,
            lat_min:-90, lat_max:90, lon_min:-180, lon_max:180,
          }),
        });
        if (!res.ok) throw new Error(`Server ${res.status}`);
        const tile = await res.json(); const pts = flattenDiff(tile);
        setMapData(pts); setStats(calcStats(pts)); return;
      }
      const ep   = viewMode === "wind" ? "/wind" : "/tile";
      const body = viewMode === "wind"
        ? { year, month, day, hour }
        : { variable, year, month, day, hour, lat_min:-90, lat_max:90, lon_min:-180, lon_max:180 };
      const res = await fetch(`${API}${ep}`, {
        method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const tile = await res.json(); const pts = flattenTile(tile);
      setMapData(pts); setStats(calcStats(pts));
    } catch (e: any) {
      setError(e.message || "Failed to load data"); setMapData([]); setStats(null);
    } finally { setLoading(false); }
  }, [variable, year, month, day, hour, viewMode, compareA, compareB]);

  const fetchSeries = useCallback(async (lon: number, lat: number) => {
    if (!variable) return;
    setSeriesLoading(true); setSeries(null); setClicked({ lat, lon });
    try {
      const res = await fetch(`${API}/timeseries`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ variable, lat, lon }),
      });
      if (!res.ok) throw new Error(`Timeseries ${res.status}`);
      setSeries(await res.json());
    } catch (e: any) { setError(e.message); }
    finally { setSeriesLoading(false); }
  }, [variable]);

  const fetchSummary = useCallback(async () => {
    if (!variable) return;
    setSummaryLoading(true); setSummary(null);
    try {
      const body: Record<string,any> = {
        variable, view_mode:viewMode, year, month, day, hour,
        stat_min:stats?.min??null, stat_max:stats?.max??null, stat_mean:stats?.mean??null,
      };
      if (clicked && series) {
        body.clicked_lat = clicked.lat; body.clicked_lon = clicked.lon;
        const step = Math.max(1, Math.floor(series.time.length/24));
        body.timeseries_times  = series.time.filter(  (_,i)=>i%step===0).slice(0,24);
        body.timeseries_values = series.values.filter((_,i)=>i%step===0).slice(0,24);
      }
      if (viewMode === "compare") {
        body.time_a = `${compareA.year}-${pad(compareA.month)}-${pad(compareA.day)} ${pad(compareA.hour)}:00`;
        body.time_b = `${compareB.year}-${pad(compareB.month)}-${pad(compareB.day)} ${pad(compareB.hour)}:00`;
      }
      const res = await fetch(`${API}/summarize`, {
        method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Summarize ${res.status}`);
      setSummary((await res.json()).summary);
    } catch {
      setSummary("Could not load summary. Check ANTHROPIC_API_KEY in your .env.");
    } finally { setSummaryLoading(false); }
  }, [variable, viewMode, year, month, day, hour, stats, clicked, series, compareA, compareB]);

  // Effects
  useEffect(() => {
    fetch(`${API}/metadata`).then(r=>r.json()).then((d: Metadata) => {
      setMetadata(d);
      if (d.variables.length) setVariable(d.variables[0]);
      if (d.years.length)     setYear(d.years[0]);
    }).catch(() =>
      fetch(`${API}/variables`).then(r=>r.json()).then(d => { if (d.variables.length) setVariable(d.variables[0]); })
    );
  }, []);

  useEffect(() => { loadTile(); }, [loadTile]);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setHour(h => { const n=h+6; if(n>18){setDay(d=>d+1);return 0;} return n; });
    }, 1200);
    return () => clearInterval(t);
  }, [playing]);

  useEffect(() => {
    setViewState(vs => viewMode==="3d" ? {...vs,pitch:45,bearing:-15} : {...vs,pitch:0,bearing:0});
  }, [viewMode]);

  useEffect(() => {
    if (!playing && stats) fetchSummary();
  }, [stats, playing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
  if (summary && !summaryLoading) {
    speakSummary(summary);
  }
}, [summary]);

  // Deck.gl layers
  const isDiff = viewMode === "compare" || viewMode === "anomaly";
  const colorRange = isDiff
    ? [[0,0,220,200],[80,100,255,200],[255,255,255,200],[255,140,80,200],[220,0,0,200]]
    : [[30,0,120,200],[90,30,200,200],[148,130,255,200],[240,180,41,200],[255,100,30,200]];
  const heatLayer = new HeatmapLayer({
    id:"heat", data:mapData,
    getPosition:(d:MapPoint)=>d.position,
    getWeight:  (d:MapPoint)=>d.value,
    radiusPixels:42, colorRange:colorRange as any, intensity:1, threshold:0.03,
  });
  const markerLayer = new ScatterplotLayer({
    id:"marker", data: clicked ? [clicked] : [],
    getPosition: (d:ClickedPoint) => [d.lon, d.lat],
    getFillColor: [148, 130, 255, 220],
    getLineColor: [255, 255, 255, 200],
    getLineWidth:2, lineWidthMinPixels:2,
    getRadius:60000, radiusMinPixels:8, stroked:true,
  });

  function CmpInputs({ label, value, onChange }: { label:string; value:CompareTime; onChange:(v:CompareTime)=>void }) {
    return (
      <div style={{ marginBottom:10 }}>
        <div style={{ fontSize:10,color:C.gold,marginBottom:5,fontFamily:FM,fontWeight:700 }}>{label}</div>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:4 }}>
          {(["year","month","day","hour"] as const).map(k => (
            <Field key={k} label={k[0].toUpperCase()+k.slice(1)}>
              <input type="number" style={iStyle} value={value[k]}
                min={k==="month"?1:k==="day"?1:k==="hour"?0:1979}
                max={k==="month"?12:k==="day"?31:k==="hour"?18:2023}
                step={k==="hour"?6:1}
                onChange={e=>onChange({...value,[k]:parseInt(e.target.value)||0})}
              />
            </Field>
          ))}
        </div>
      </div>
    );
  }

  const showTS = series || seriesLoading;

  return (
    <div style={{ display:"flex",flexDirection:"column",height:"100vh",overflow:"hidden",fontFamily:FS,background:C.bg,color:C.text }}>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap');
        @keyframes spin    { to   { transform:rotate(360deg); } }
        @keyframes pulse   { 0%,100%{opacity:.15;transform:scale(.7)} 50%{opacity:1;transform:scale(1.2)} }
        @keyframes fadeUp  { from { opacity:0;transform:translateY(5px) } to { opacity:1;transform:translateY(0) } }
        @keyframes liveDot { 0%,100%{opacity:.4} 50%{opacity:1} }
        ::-webkit-scrollbar       { width:3px; }
        ::-webkit-scrollbar-thumb { background:rgba(148,130,255,.18); border-radius:2px; }
        input[type=number]::-webkit-inner-spin-button { opacity:.22; }
        select option { background:#111520; }
        input:focus, select:focus { border-color:rgba(148,130,255,.42) !important; box-shadow:0 0 0 2px rgba(148,130,255,.08); }
      `}</style>

      {/* Header */}
      <header style={{
        height:50,flexShrink:0,display:"flex",alignItems:"center",
        background:C.surface,borderBottom:`1px solid ${C.border}`,
        padding:"0 20px",gap:16,zIndex:20,
        boxShadow:"0 1px 28px rgba(0,0,0,.7)",
      }}>
        <div style={{ display:"flex",alignItems:"center",gap:10 }}>
          <div style={{
            width:30,height:30,borderRadius:"50%",
            background:`radial-gradient(circle at 35% 35%,${C.accent},#3a1f90)`,
            boxShadow:`0 0 16px rgba(148,130,255,.32)`,
            display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,
          }}>🌍</div>
          <div>
            <span style={{ fontSize:15,fontWeight:700,color:C.accent,letterSpacing:-.5 }}>PyClima</span>
            <span style={{ fontSize:15,fontWeight:700,color:C.gold,  letterSpacing:-.5 }}>Explorer</span>
          </div>
        </div>
        <div style={{ width:1,height:22,background:C.border }}/>
        <span style={{ fontSize:10,color:C.textDim,fontFamily:FM,letterSpacing:1 }}>ERA5 REANALYSIS · GLOBAL CLIMATE</span>
        <div style={{ flex:1 }}/>
        {playing && (
          <div style={{ display:"flex",alignItems:"center",gap:6,padding:"4px 12px",background:"rgba(255,107,107,.07)",border:"1px solid rgba(255,107,107,.22)",borderRadius:20 }}>
            <div style={{ width:6,height:6,borderRadius:"50%",background:C.danger,animation:"liveDot 1s infinite" }}/>
            <span style={{ fontSize:10,color:C.danger,fontFamily:FM,letterSpacing:1 }}>LIVE</span>
          </div>
        )}
        <div style={{ fontSize:11,color:C.textMid,fontFamily:FM,background:"rgba(0,0,0,.3)",padding:"5px 14px",borderRadius:20,border:`1px solid ${C.border}` }}>
          {year}-{pad(month)}-{pad(day)} · {pad(hour)}:00 UTC
        </div>
      </header>

      <div style={{ display:"flex",flex:1,overflow:"hidden" }}>

        {/* Sidebar */}
        <aside style={{
          width:274,display:"flex",flexDirection:"column",
          background:C.surface,borderRight:`1px solid ${C.border}`,
          overflowY:"auto",flexShrink:0,zIndex:10,
        }}>
          <Section title="View Mode">
            <div style={{ display:"flex",gap:4,flexWrap:"wrap" }}>
              <MBtn active={viewMode==="heatmap"} onClick={()=>setViewMode("heatmap")} icon="🌡️" label="Heat"    />
              <MBtn active={viewMode==="3d"}      onClick={()=>setViewMode("3d")}      icon="🌍" label="Globe"   />
              <MBtn active={viewMode==="wind"}    onClick={()=>setViewMode("wind")}    icon="💨" label="Wind"    />
              <MBtn active={viewMode==="anomaly"} onClick={()=>setViewMode("anomaly")} icon="📊" label="Anomaly" />
              <MBtn active={viewMode==="compare"} onClick={()=>setViewMode("compare")} icon="⇄"  label="Compare" />
            </div>
          </Section>

          <Section title="Variable">
            <select style={{ ...iStyle,cursor:"pointer" }} value={variable} onChange={e=>setVariable(e.target.value)}>
              {(metadata?.variables??[]).map(v=><option key={v} value={v}>{v}</option>)}
            </select>
          </Section>

          {viewMode !== "compare" && (
            <Section title="Time">
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:6 }}>
                <Field label="Year">
                  <input type="number" style={iStyle} value={year}
                    min={metadata?.years[0]??1979} max={metadata?.years[metadata.years.length-1]??2023}
                    onChange={e=>setYear(parseInt(e.target.value))}/>
                </Field>
                <Field label="Month">
                  <input type="number" style={iStyle} value={month} min={1} max={12}
                    onChange={e=>setMonth(parseInt(e.target.value))}/>
                </Field>
                <Field label="Day">
                  <input type="number" style={iStyle} value={day} min={1} max={31}
                    onChange={e=>setDay(parseInt(e.target.value))}/>
                </Field>
                <Field label="Hour UTC">
                  <input type="number" style={iStyle} value={hour} min={0} max={18} step={6}
                    onChange={e=>setHour(parseInt(e.target.value))}/>
                </Field>
              </div>
              <div style={{ marginTop:6,fontSize:11,color:C.textDim,fontFamily:FM }}>
                {year}-{pad(month)}-{pad(day)} {pad(hour)}:00 UTC
              </div>
            </Section>
          )}

          {viewMode === "compare" && (
            <Section title="Compare Timestamps">
              <CmpInputs label="Time A" value={compareA} onChange={setCompareA}/>
              <CmpInputs label="Time B" value={compareB} onChange={setCompareB}/>
            </Section>
          )}

          <Section title="Controls">
            {viewMode !== "compare" && (
              <button style={{
                width:"100%",padding:"10px",marginBottom:7,
                background: playing ? "rgba(255,107,107,.09)" : C.accentLo,
                border:`1px solid ${playing ? "rgba(255,107,107,.3)" : C.borderHi}`,
                borderRadius:9,color: playing ? C.danger : C.accent,
                fontWeight:600,fontSize:12,cursor:"pointer",
                fontFamily:FM,letterSpacing:.5,transition:"all 0.18s",
                boxShadow: playing ? "0 0 14px rgba(255,107,107,.1)" : `0 0 14px rgba(148,130,255,.08)`,
              }} onClick={()=>setPlaying(!playing)}>
                {playing ? "⏸  PAUSE" : "▶  PLAY TIMELINE"}
              </button>
            )}
            <button style={{
              width:"100%",padding:"10px",
              background: inspectMode ? C.goldLo : "rgba(0,0,0,.2)",
              border:`1px solid ${inspectMode ? "rgba(240,180,41,.38)" : C.border}`,
              borderRadius:9,color: inspectMode ? C.gold : C.textDim,
              fontWeight:600,fontSize:12,cursor:"pointer",
              fontFamily:FM,letterSpacing:.5,transition:"all 0.18s",
            }} onClick={()=>{ setInspectMode(!inspectMode); if(inspectMode){setSeries(null);setClicked(null);} }}>
              {inspectMode ? "✦ INSPECT ON" : "✦ INSPECT OFF"}
            </button>
          </Section>

          <Section title="Statistics">
            {loading ? (
              <div style={{ fontSize:11,color:C.textDim,fontFamily:FM }}>loading…</div>
            ) : stats ? (
              <div style={{ display:"flex",gap:6 }}>
                <StatCard label="Min"  value={stats.min}  />
                <StatCard label="Mean" value={stats.mean} />
                <StatCard label="Max"  value={stats.max}  />
              </div>
            ) : (
              <div style={{ fontSize:11,color:C.textDim,fontFamily:FM }}>no data loaded</div>
            )}
          </Section>

          <Section title="Legend">
            <div style={{ fontSize:9,color:C.textDim,marginBottom:5,fontFamily:FM,letterSpacing:1 }}>
              {isDiff ? "NEG  ◂──────────▸  POS" : "LOW  ◂──────────▸  HIGH"}
            </div>
            <div style={{
              height:8,borderRadius:4,marginBottom:6,
              background: isDiff
                ? "linear-gradient(to right,#0000dc,#7080ff,#fff,#ffb060,#dc0000)"
                : "linear-gradient(to right,#1e0078,#9482ff,#f0b429,#ff6420)",
              boxShadow:`0 0 8px rgba(148,130,255,.1)`,
            }}/>
            <div style={{ display:"flex",justifyContent:"space-between",fontSize:10,color:C.textDim,fontFamily:FM }}>
              {stats
                ? <><span>{stats.min.toFixed(1)}</span><span>{stats.mean.toFixed(1)}</span><span>{stats.max.toFixed(1)}</span></>
                : <><span>low</span><span>high</span></>}
            </div>
          </Section>

          <AISummary summary={summary} loading={summaryLoading} onRefresh={fetchSummary}/>

          {clicked && (
            <Section title="Selected Point" last>
              <div style={{ fontSize:12,color:C.text,fontFamily:FM,background:C.accentLo,borderRadius:8,padding:"8px 10px",border:`1px solid ${C.border}` }}>
                📍 {clicked.lat.toFixed(3)}°N · {clicked.lon.toFixed(3)}°E
              </div>
              <button style={{ marginTop:6,fontSize:10,color:C.textDim,background:"none",border:"none",cursor:"pointer",padding:0,fontFamily:FM }}
                onClick={()=>{ setSeries(null); setClicked(null); }}>✕ clear pin</button>
            </Section>
          )}

          {error && (
            <div style={{ margin:"10px 14px",padding:"10px 12px",background:"rgba(255,107,107,.06)",border:"1px solid rgba(255,107,107,.18)",borderRadius:10,fontSize:11,color:C.danger,fontFamily:FM,lineHeight:1.65 }}>
              ⚠ {error}
            </div>
          )}
        </aside>

        {/* Map / Globe */}
        <div style={{ flex:1,position:"relative" }}>
          {loading && (
            <div style={{ position:"absolute",inset:0,zIndex:20,pointerEvents:"none",display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(12,14,20,.65)",backdropFilter:"blur(4px)" }}>
              <div style={{ textAlign:"center" }}>
                <div style={{ width:46,height:46,borderRadius:"50%",margin:"0 auto 14px",border:`2px solid rgba(148,130,255,.15)`,borderTopColor:C.accent,animation:"spin 0.9s linear infinite" }}/>
                <div style={{ fontSize:11,color:C.accent,fontFamily:FM,letterSpacing:1 }}>LOADING…</div>
              </div>
            </div>
          )}

          {/* Mode badge */}
          <div style={{
            position:"absolute",top:14,left:14,zIndex:15,
            background:"rgba(17,21,32,.92)",border:`1px solid ${C.border}`,
            borderRadius:20,padding:"6px 16px",fontSize:11,color:C.accent,
            backdropFilter:"blur(10px)",fontFamily:FM,letterSpacing:.5,
            display:"flex",alignItems:"center",gap:8,
            boxShadow:"0 2px 20px rgba(0,0,0,.5)",
          }}>
            {viewMode==="heatmap" && "🌡️ HEATMAP"}
            {viewMode==="3d"      && "🌍 GLOBE"}
            {viewMode==="wind"    && "💨 WIND"}
            {viewMode==="anomaly" && "📊 ANOMALY"}
            {viewMode==="compare" && "⇄ COMPARE"}
            <span style={{ color:C.textDim }}>· {variable}</span>
            {inspectMode && <span style={{ color:C.gold }}>· ✦ inspect</span>}
          </div>

          {/* Inspect hint (flat map modes) */}
          {inspectMode && !clicked && viewMode !== "3d" && (
            <div style={{
              position:"absolute",bottom:24,left:"50%",transform:"translateX(-50%)",
              zIndex:15,background:"rgba(240,180,41,.92)",borderRadius:24,
              padding:"9px 24px",fontSize:12,color:"#0c0e14",
              whiteSpace:"nowrap",fontFamily:FM,fontWeight:700,letterSpacing:.5,
              boxShadow:"0 4px 20px rgba(240,180,41,.3)",
            }}>
              CLICK MAP TO INSPECT TIME SERIES
            </div>
          )}

          {viewMode === "3d" ? (
            <GlobeView
              mapData={mapData}
              stats={stats}
              isDiff={isDiff}
              inspectMode={inspectMode}
              onGlobeClick={(lon, lat) => fetchSeries(lon, lat)}
            />
          ) : (
            <DeckGL
              viewState={viewState}
              controller={true}
              layers={[heatLayer, markerLayer]}
              onViewStateChange={({ viewState:vs }:any) => setViewState(vs)}
              onClick={(info:any) => {
                if (!inspectMode || !info.coordinate) return;
                const [lon, lat] = info.coordinate;
                fetchSeries(lon, lat);
              }}
              style={{ position:"absolute",inset:0 }}
              getCursor={({ isDragging }:any) => inspectMode ? "crosshair" : isDragging ? "grabbing" : "grab"}
            >
              <Map mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"/>
            </DeckGL>
          )}
        </div>
      </div>

      {/* Time series panel */}
      {showTS && (
        <div style={{ height:280,flexShrink:0,zIndex:5,background:C.surface,borderTop:`1px solid ${C.border}`,display:"flex",flexDirection:"column" }}>
          <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 22px 0" }}>
            <div style={{ display:"flex",alignItems:"center",gap:10 }}>
              <div style={{ width:3,height:24,borderRadius:2,background:`linear-gradient(to bottom,${C.accent},${C.gold})` }}/>
              <div>
                <span style={{ fontSize:13,fontWeight:700,color:C.text }}>{variable}</span>
                <span style={{ fontSize:10,color:C.textDim,marginLeft:8,fontFamily:FM }}>TIME SERIES</span>
                {clicked && <span style={{ fontSize:10,color:C.textDim,marginLeft:10,fontFamily:FM }}>@ {clicked.lat.toFixed(3)}°N · {clicked.lon.toFixed(3)}°E</span>}
              </div>
            </div>
            <button onClick={()=>{ setSeries(null); setClicked(null); setSeriesLoading(false); }}
              style={{ background:C.accentLo,border:`1px solid ${C.border}`,borderRadius:8,color:C.textMid,cursor:"pointer",fontSize:13,padding:"4px 10px",fontFamily:FM,transition:"all 0.18s" }}>
              ✕
            </button>
          </div>
          {seriesLoading ? (
            <div style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center",color:C.textDim,fontSize:11,fontFamily:FM,letterSpacing:1 }}>
              FETCHING TIME SERIES…
            </div>
          ) : series ? (
            <Plot
              data={[{
                x:series.time, y:series.values,
                type:"scatter", mode:"lines",
                line:{ color:C.accent, width:1.8 },
                fill:"tozeroy", fillcolor:"rgba(148,130,255,0.07)",
              }]}
              layout={{
                height:228,
                margin:{ t:12,l:58,r:22,b:52 },
                paper_bgcolor:"transparent", plot_bgcolor:"transparent",
                font:{ color:C.textDim,size:10,family:FM },
                xaxis:{ title:{text:"TIME",font:{size:10}},gridcolor:"rgba(148,130,255,.06)",linecolor:"rgba(148,130,255,.12)",tickfont:{size:9},tickcolor:"rgba(148,130,255,.2)" },
                yaxis:{ title:{text:variable,font:{size:10}},gridcolor:"rgba(148,130,255,.06)",linecolor:"rgba(148,130,255,.12)",tickfont:{size:9},tickcolor:"rgba(148,130,255,.2)" },
              }}
              config={{ responsive:true, displayModeBar:false }}
              style={{ width:"100%" }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
