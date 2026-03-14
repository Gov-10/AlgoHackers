"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import DeckGL from "@deck.gl/react";
import { HeatmapLayer } from "@deck.gl/aggregation-layers";
import { ScatterplotLayer } from "@deck.gl/layers";
import { Map } from "react-map-gl/maplibre";
import dynamic from "next/dynamic";
const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

const API = "http://localhost:8000";

// ─── Types ───────────────────────────────────────────────────────────────────
type ViewMode = "heatmap" | "3d" | "compare" | "wind" | "anomaly";
interface MapPoint { position: [number, number]; value: number; }
interface ClickedPoint { lat: number; lon: number; }
interface TimeSeriesData { time: string[]; values: number[]; }
interface CompareTime { year: number; month: number; day: number; hour: number; }
interface Metadata {
  variables: string[];
  years: number[];
  lat_range: [number, number];
  lon_range: [number, number];
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, "0");
function calcStats(points: MapPoint[]) {
  if (!points.length) return null;
  const vals = points.map((p) => p.value).filter((v) => isFinite(v));
  if (!vals.length) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { min, max, mean };
}
function flattenTile(tile: { lat: number[]; lon: number[]; values: number[][] }): MapPoint[] {
  const points: MapPoint[] = [];
  for (let i = 0; i < tile.lat.length; i++)
    for (let j = 0; j < tile.lon.length; j++) {
      const v = tile.values[i][j];
      if (isFinite(v)) points.push({ position: [tile.lon[j], tile.lat[i]], value: v });
    }
  return points;
}
function flattenDiff(tile: { lat: number[]; lon: number[]; diff: number[][] }): MapPoint[] {
  const points: MapPoint[] = [];
  for (let i = 0; i < tile.lat.length; i++)
    for (let j = 0; j < tile.lon.length; j++) {
      const v = tile.diff[i][j];
      if (isFinite(v)) points.push({ position: [tile.lon[j], tile.lat[i]], value: v });
    }
  return points;
}

// ─── Globe3D Component ────────────────────────────────────────────────────────
function Globe3D({ mapData, stats, isDiff }: { mapData: MapPoint[]; stats: { min: number; max: number; mean: number } | null; isDiff: boolean }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<any>(null);

  useEffect(() => {
    if (!mountRef.current) return;
    let animFrameId: number;
    let renderer: any, scene: any, camera: any, globe: any, atmosphere: any, stars: any, dataPoints: any;
    let isDragging = false, prevMouse = { x: 0, y: 0 };
    let rotX = 0.3, rotY = 0;
    let autoRotate = true;

    (async () => {
      const THREE = await import("three");
      const W = mountRef.current!.clientWidth;
      const H = mountRef.current!.clientHeight;

      // Renderer
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setSize(W, H);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x000000, 0);
      mountRef.current!.appendChild(renderer.domElement);

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 1000);
      camera.position.z = 2.8;

      // ── Starfield ──
      const starGeo = new THREE.BufferGeometry();
      const starCount = 3000;
      const starPos = new Float32Array(starCount * 3);
      for (let i = 0; i < starCount * 3; i++) starPos[i] = (Math.random() - 0.5) * 200;
      starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
      stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.12, transparent: true, opacity: 0.7 }));
      scene.add(stars);

      // ── Earth Globe ──
      const loader = new THREE.TextureLoader();
      // Use NASA Blue Marble texture via public CDN
      const earthTexture = loader.load(
        "https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg",
        undefined, undefined,
        () => {
          // fallback procedural texture if load fails
          const canvas = document.createElement("canvas");
          canvas.width = 512; canvas.height = 256;
          const ctx = canvas.getContext("2d")!;
          const grad = ctx.createLinearGradient(0, 0, 0, 256);
          grad.addColorStop(0, "#0a2a6e");
          grad.addColorStop(0.3, "#1a5276");
          grad.addColorStop(0.5, "#1e8449");
          grad.addColorStop(0.7, "#1a5276");
          grad.addColorStop(1, "#0a2a6e");
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, 512, 256);
          globe.material.map = new THREE.CanvasTexture(canvas);
          globe.material.needsUpdate = true;
        }
      );

      const globeGeo = new THREE.SphereGeometry(1, 64, 64);
      const globeMat = new THREE.MeshPhongMaterial({
        map: earthTexture,
        specular: new THREE.Color(0x1a3a5c),
        shininess: 15,
      });
      globe = new THREE.Mesh(globeGeo, globeMat);
      scene.add(globe);

      // ── Cloud Layer ──
      const cloudTexture = loader.load("https://unpkg.com/three-globe/example/img/earth-clouds.png");
      const cloudMesh = new THREE.Mesh(
        new THREE.SphereGeometry(1.008, 64, 64),
        new THREE.MeshPhongMaterial({ map: cloudTexture, transparent: true, opacity: 0.35, depthWrite: false })
      );
      scene.add(cloudMesh);

      // ── Atmosphere Glow ──
      const atmGeo = new THREE.SphereGeometry(1.18, 64, 64);
      const atmMat = new THREE.ShaderMaterial({
        vertexShader: `
          varying vec3 vNormal;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          varying vec3 vNormal;
          void main() {
            float intensity = pow(0.65 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.0);
            gl_FragColor = vec4(0.15, 0.7, 1.0, 1.0) * intensity;
          }
        `,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        transparent: true,
      });
      atmosphere = new THREE.Mesh(atmGeo, atmMat);
      scene.add(atmosphere);

      // ── Equatorial Ring ──
      const ringGeo = new THREE.TorusGeometry(1.22, 0.003, 8, 120);
      const ringMat = new THREE.MeshBasicMaterial({ color: 0x00d084, transparent: true, opacity: 0.25 });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = Math.PI / 2;
      scene.add(ring);

      // ── Lighting ──
      const ambientLight = new THREE.AmbientLight(0x334466, 0.6);
      scene.add(ambientLight);
      const sunLight = new THREE.DirectionalLight(0xffeedd, 1.4);
      sunLight.position.set(5, 3, 5);
      scene.add(sunLight);
      const rimLight = new THREE.DirectionalLight(0x0044aa, 0.4);
      rimLight.position.set(-5, -2, -3);
      scene.add(rimLight);

      // ── Data Points on Globe ──
      function buildDataPoints(pts: MapPoint[], s: { min: number; max: number } | null) {
        if (dataPoints) { scene.remove(dataPoints); dataPoints.geometry.dispose(); }
        if (!pts.length) return;
        const geo = new THREE.BufferGeometry();
        const positions: number[] = [];
        const colors: number[] = [];
        const sizes: number[] = [];
        const min = s?.min ?? 0, max = s?.max ?? 1;
        const range = max - min || 1;
        const subset = pts.length > 4000 ? pts.filter((_, i) => i % Math.ceil(pts.length / 4000) === 0) : pts;
        subset.forEach(({ position: [lon, lat], value }) => {
          const phi = (90 - lat) * (Math.PI / 180);
          const theta = (lon + 180) * (Math.PI / 180);
          const r = 1.012;
          positions.push(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
          const t = (value - min) / range;
          if (isDiff) {
            colors.push(t < 0.5 ? 0 : (t - 0.5) * 2, 0.1, t > 0.5 ? 0 : (0.5 - t) * 2);
          } else {
            colors.push(t > 0.66 ? 1 : t * 1.5, t > 0.33 && t < 0.66 ? 1 : 0, t < 0.33 ? 1 - t * 3 : 0);
          }
          sizes.push(2.5 + t * 3.5);
        });
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
        geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colors), 3));
        geo.setAttribute("size", new THREE.BufferAttribute(new Float32Array(sizes), 1));
        const mat = new THREE.ShaderMaterial({
          vertexShader: `
            attribute float size;
            attribute vec3 color;
            varying vec3 vColor;
            void main() {
              vColor = color;
              vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
              gl_PointSize = size * (300.0 / -mvPos.z);
              gl_Position = projectionMatrix * mvPos;
            }
          `,
          fragmentShader: `
            varying vec3 vColor;
            void main() {
              float d = length(gl_PointCoord - vec2(0.5));
              if (d > 0.5) discard;
              float alpha = smoothstep(0.5, 0.1, d) * 0.85;
              gl_FragColor = vec4(vColor, alpha);
            }
          `,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          vertexColors: true,
        });
        dataPoints = new THREE.Points(geo, mat);
        scene.add(dataPoints);
      }

      buildDataPoints(mapData, stats);
      sceneRef.current = { buildDataPoints };

      // ── Mouse Interaction ──
      const el = renderer.domElement;
      const onDown = (e: MouseEvent) => { isDragging = true; autoRotate = false; prevMouse = { x: e.clientX, y: e.clientY }; };
      const onUp = () => { isDragging = false; };
      const onMove = (e: MouseEvent) => {
        if (!isDragging) return;
        const dx = e.clientX - prevMouse.x, dy = e.clientY - prevMouse.y;
        rotY += dx * 0.005; rotX += dy * 0.005;
        rotX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, rotX));
        prevMouse = { x: e.clientX, y: e.clientY };
      };
      const onWheel = (e: WheelEvent) => {
        camera.position.z = Math.max(1.5, Math.min(6, camera.position.z + e.deltaY * 0.003));
      };
      el.addEventListener("mousedown", onDown);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("mousemove", onMove);
      el.addEventListener("wheel", onWheel);

      // ── Animate ──
      const clock = new THREE.Clock();
      const animate = () => {
        animFrameId = requestAnimationFrame(animate);
        const dt = clock.getDelta();
        if (autoRotate) rotY += dt * 0.06;
        globe.rotation.y = rotY;
        globe.rotation.x = rotX;
        if (dataPoints) { dataPoints.rotation.y = rotY; dataPoints.rotation.x = rotX; }
        cloudMesh.rotation.y = rotY + clock.getElapsedTime() * 0.008;
        cloudMesh.rotation.x = rotX;
        stars.rotation.y += dt * 0.003;
        renderer.render(scene, camera);
      };
      animate();

      // ── Resize ──
      const onResize = () => {
        if (!mountRef.current) return;
        const W2 = mountRef.current.clientWidth, H2 = mountRef.current.clientHeight;
        camera.aspect = W2 / H2; camera.updateProjectionMatrix();
        renderer.setSize(W2, H2);
      };
      window.addEventListener("resize", onResize);

      return () => {
        cancelAnimationFrame(animFrameId);
        el.removeEventListener("mousedown", onDown);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("mousemove", onMove);
        el.removeEventListener("wheel", onWheel);
        window.removeEventListener("resize", onResize);
        renderer.dispose();
        if (mountRef.current && renderer.domElement.parentNode === mountRef.current)
          mountRef.current.removeChild(renderer.domElement);
      };
    })();

    return () => { cancelAnimationFrame(animFrameId); };
  }, []);

  // Update data points when mapData changes
  useEffect(() => {
    if (sceneRef.current?.buildDataPoints) sceneRef.current.buildDataPoints(mapData, stats);
  }, [mapData, stats]);

  return (
    <div ref={mountRef} style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 40% 40%, #020d1a 0%, #000508 100%)" }}>
      <div style={{
        position: "absolute", bottom: 18, right: 18, fontSize: 11, color: "rgba(0,208,132,0.5)",
        fontFamily: "'Space Mono', monospace", letterSpacing: 1,
        background: "rgba(0,0,0,0.4)", padding: "5px 10px", borderRadius: 6,
        border: "1px solid rgba(0,208,132,0.12)",
      }}>
        DRAG TO ROTATE · SCROLL TO ZOOM
      </div>
    </div>
  );
}

// ─── Presentational components ────────────────────────────────────────────────
function StatCard({ label, value }: { label: string; value: number | null }) {
  return (
    <div style={{
      background: "linear-gradient(135deg, rgba(0,210,132,0.07) 0%, rgba(0,100,80,0.04) 100%)",
      border: "1px solid rgba(0,210,132,0.18)",
      borderRadius: 10, padding: "9px 13px", flex: 1, minWidth: 0,
      position: "relative", overflow: "hidden",
    }}>
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 1,
        background: "linear-gradient(90deg, transparent, rgba(0,210,132,0.4), transparent)",
      }} />
      <div style={{ fontSize: 9, color: "#3d7a55", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 4, fontFamily: "'Space Mono', monospace" }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: "#7fffc4", fontVariantNumeric: "tabular-nums", fontFamily: "'Space Mono', monospace" }}>
        {value != null ? value.toFixed(2) : "—"}
      </div>
    </div>
  );
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: "13px 16px", borderBottom: "1px solid rgba(0,210,132,0.07)" }}>
      <div style={{
        fontSize: 9, color: "#2d6640", textTransform: "uppercase", letterSpacing: 2.5,
        fontWeight: 700, marginBottom: 10, fontFamily: "'Space Mono', monospace",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <span style={{ display: "inline-block", width: 16, height: 1, background: "rgba(0,210,132,0.3)" }} />
        {title}
        <span style={{ display: "inline-block", flex: 1, height: 1, background: "rgba(0,210,132,0.1)" }} />
      </div>
      {children}
    </div>
  );
}

function LabeledInput({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 7 }}>
      <div style={{ fontSize: 10, color: "#3d6645", marginBottom: 3, fontFamily: "'Space Mono', monospace", letterSpacing: 0.5 }}>{label}</div>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "rgba(0,0,0,0.45)",
  border: "1px solid rgba(0,210,132,0.15)",
  borderRadius: 7, color: "#9de8c0",
  padding: "7px 10px", fontSize: 12,
  boxSizing: "border-box", outline: "none",
  fontFamily: "'Space Mono', monospace",
  transition: "border-color 0.2s",
};

function ModeButton({ active, onClick, icon, label }: {
  active: boolean; onClick: () => void; icon: string; label: string;
}) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: "8px 3px",
      background: active
        ? "linear-gradient(135deg, rgba(0,210,132,0.2) 0%, rgba(0,150,100,0.1) 100%)"
        : "rgba(0,0,0,0.2)",
      border: `1px solid ${active ? "rgba(0,210,132,0.55)" : "rgba(0,210,132,0.1)"}`,
      borderRadius: 8, color: active ? "#00e89a" : "#3d6645",
      cursor: "pointer", fontSize: 10,
      display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
      transition: "all 0.2s", fontFamily: "'Space Mono', monospace",
      letterSpacing: 0.5,
      boxShadow: active ? "0 0 14px rgba(0,210,132,0.15), inset 0 1px 0 rgba(0,210,132,0.2)" : "none",
    }}>
      <span style={{ fontSize: 17 }}>{icon}</span>
      {label}
    </button>
  );
}

function SummaryPanel({ summary, loading, onRefresh }: {
  summary: string | null; loading: boolean; onRefresh: () => void;
}) {
  return (
    <div style={{
      margin: "10px 14px",
      background: "linear-gradient(135deg, rgba(0,210,132,0.05) 0%, rgba(0,60,40,0.04) 100%)",
      border: "1px solid rgba(0,210,132,0.15)",
      borderRadius: 12, padding: "12px 14px", minHeight: 72,
      position: "relative", overflow: "hidden",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:ital@0;1&family=Syne:wght@400;600;700;800&display=swap');
        @keyframes climaPulse { 0%,100%{opacity:0.15;transform:scale(0.7)} 50%{opacity:1;transform:scale(1.2)} }
        @keyframes shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
        @keyframes fadeSlideIn { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:translateY(0)} }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(0,210,132,0.2); border-radius: 2px; }
        input[type=number]::-webkit-inner-spin-button { opacity: 0.3; }
        select option { background: #060f08; }
      `}</style>
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 1,
        background: "linear-gradient(90deg, transparent, rgba(0,210,132,0.5), transparent)",
      }} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
        <div style={{ fontSize: 9, color: "#2d6640", textTransform: "uppercase", letterSpacing: 2, fontWeight: 700, fontFamily: "'Space Mono', monospace", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12 }}>🤖</span> AI Analysis
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          style={{
            background: loading ? "none" : "rgba(0,210,132,0.08)",
            border: "1px solid rgba(0,210,132,0.2)",
            borderRadius: 6, color: loading ? "#2d5c40" : "#00d084",
            fontSize: 10, cursor: loading ? "default" : "pointer",
            padding: "4px 10px", fontFamily: "'Space Mono', monospace",
            transition: "all 0.2s", letterSpacing: 0.5,
          }}
        >
          {loading ? "···" : "↺ Refresh"}
        </button>
      </div>
      {loading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", gap: 5 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{
                width: 5, height: 5, borderRadius: "50%", background: "#00d084",
                animation: `climaPulse 1.4s ease-in-out ${i * 0.22}s infinite`,
              }} />
            ))}
          </div>
          <span style={{ fontSize: 11, color: "#2d5c40", fontFamily: "'Space Mono', monospace" }}>analyzing data…</span>
        </div>
      ) : summary ? (
        <p style={{
          fontSize: 12, color: "#88c9a0", lineHeight: 1.75, margin: 0,
          maxHeight: 130, overflowY: "auto", paddingRight: 4,
          wordBreak: "break-word", overflowWrap: "anywhere",
          animation: "fadeSlideIn 0.3s ease",
          fontFamily: "'Syne', sans-serif", fontWeight: 400,
        }}>{summary}</p>
      ) : (
        <p style={{ fontSize: 11, color: "#2d5040", margin: 0, fontStyle: "italic", fontFamily: "'Space Mono', monospace", lineHeight: 1.7 }}>
          Click ↺ Refresh to get an AI explanation.
        </p>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Page() {
  const [metadata, setMetadata]           = useState<Metadata | null>(null);
  const [variable, setVariable]           = useState("");
  const [year, setYear]                   = useState(2022);
  const [month, setMonth]                 = useState(1);
  const [day, setDay]                     = useState(1);
  const [hour, setHour]                   = useState(0);
  const [viewMode, setViewMode]           = useState<ViewMode>("heatmap");
  const [inspectMode, setInspectMode]     = useState(false);
  const [playing, setPlaying]             = useState(false);
  const [viewState, setViewState]         = useState({ longitude: 0, latitude: 20, zoom: 2, pitch: 0, bearing: 0 });
  const [mapData, setMapData]             = useState<MapPoint[]>([]);
  const [loading, setLoading]             = useState(false);
  const [error, setError]                 = useState<string | null>(null);
  const [stats, setStats]                 = useState<{ min: number; max: number; mean: number } | null>(null);
  const [series, setSeries]               = useState<TimeSeriesData | null>(null);
  const [clicked, setClicked]             = useState<ClickedPoint | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [compareA, setCompareA]           = useState<CompareTime>({ year: 2020, month: 1, day: 1, hour: 0 });
  const [compareB, setCompareB]           = useState<CompareTime>({ year: 2022, month: 1, day: 1, hour: 0 });
  const [summary, setSummary]             = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const playRef = useRef(playing);
  playRef.current = playing;

  const loadTile = useCallback(async () => {
    if (!variable) return;
    setLoading(true); setError(null);
    try {
      if (viewMode === "anomaly") {
        const url = `${API}/anomaly?variable=${variable}&year=${year}&month=${month}&day=${day}&hour=${hour}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        const tile = await res.json();
        const pts = flattenTile(tile);
        setMapData(pts); setStats(calcStats(pts)); return;
      }
      if (viewMode === "compare") {
        const res = await fetch(`${API}/compare`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            variable,
            year_a: compareA.year, month_a: compareA.month, day_a: compareA.day, hour_a: compareA.hour,
            year_b: compareB.year, month_b: compareB.month, day_b: compareB.day, hour_b: compareB.hour,
            lat_min: -90, lat_max: 90, lon_min: -180, lon_max: 180,
          }),
        });
        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        const tile = await res.json();
        const pts = flattenDiff(tile);
        setMapData(pts); setStats(calcStats(pts)); return;
      }
      const endpoint = viewMode === "wind" ? "/wind" : "/tile";
      const body = viewMode === "wind"
        ? { year, month, day, hour }
        : { variable, year, month, day, hour, lat_min: -90, lat_max: 90, lon_min: -180, lon_max: 180 };
      const res = await fetch(`${API}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const tile = await res.json();
      const pts = flattenTile(tile);
      setMapData(pts); setStats(calcStats(pts));
    } catch (e: any) {
      setError(e.message || "Failed to load data");
      setMapData([]); setStats(null);
    } finally {
      setLoading(false);
    }
  }, [variable, year, month, day, hour, viewMode, compareA, compareB]);

  const fetchSeries = useCallback(async (lon: number, lat: number) => {
    if (!variable) return;
    setSeriesLoading(true); setSeries(null); setClicked({ lat, lon });
    try {
      const res = await fetch(`${API}/timeseries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variable, lat, lon }),
      });
      if (!res.ok) throw new Error(`Timeseries error: ${res.status}`);
      const data = await res.json();
      setSeries(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSeriesLoading(false);
    }
  }, [variable]);

  const fetchSummary = useCallback(async () => {
    if (!variable) return;
    setSummaryLoading(true); setSummary(null);
    try {
      const body: Record<string, any> = {
        variable, view_mode: viewMode, year, month, day, hour,
        stat_min: stats?.min ?? null, stat_max: stats?.max ?? null, stat_mean: stats?.mean ?? null,
      };
      if (clicked && series) {
        body.clicked_lat = clicked.lat; body.clicked_lon = clicked.lon;
        const step = Math.max(1, Math.floor(series.time.length / 24));
        body.timeseries_times  = series.time.filter((_, i) => i % step === 0).slice(0, 24);
        body.timeseries_values = series.values.filter((_, i) => i % step === 0).slice(0, 24);
      }
      if (viewMode === "compare") {
        body.time_a = `${compareA.year}-${pad(compareA.month)}-${pad(compareA.day)} ${pad(compareA.hour)}:00`;
        body.time_b = `${compareB.year}-${pad(compareB.month)}-${pad(compareB.day)} ${pad(compareB.hour)}:00`;
      }
      const res = await fetch(`${API}/summarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Summarizer error: ${res.status}`);
      const data = await res.json();
      setSummary(data.summary);
    } catch (e: any) {
      setSummary("Could not load summary. Check that ANTHROPIC_API_KEY is set in your .env.");
    } finally {
      setSummaryLoading(false);
    }
  }, [variable, viewMode, year, month, day, hour, stats, clicked, series, compareA, compareB]);

  useEffect(() => {
    fetch(`${API}/metadata`)
      .then((r) => r.json())
      .then((d: Metadata) => {
        setMetadata(d);
        if (d.variables.length > 0) setVariable(d.variables[0]);
        if (d.years.length > 0) setYear(d.years[0]);
      })
      .catch(() => {
        fetch(`${API}/variables`)
          .then((r) => r.json())
          .then((d) => { if (d.variables.length > 0) setVariable(d.variables[0]); });
      });
  }, []);

  useEffect(() => { loadTile(); }, [loadTile]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setHour((h) => {
        const next = h + 6;
        if (next > 18) { setDay((d) => d + 1); return 0; }
        return next;
      });
    }, 1200);
    return () => clearInterval(timer);
  }, [playing]);

  useEffect(() => {
    setViewState((vs) => viewMode === "3d"
      ? { ...vs, pitch: 45, bearing: -15 }
      : { ...vs, pitch: 0, bearing: 0 }
    );
  }, [viewMode]);

  useEffect(() => {
    if (!playing && stats) fetchSummary();
  }, [stats, playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Deck layers ──
  const isDiff = viewMode === "compare" || viewMode === "anomaly";
  const colorRange = isDiff
    ? [[0,0,255,200],[100,150,255,200],[255,255,255,200],[255,150,100,200],[255,0,0,200]]
    : [[0,0,180,200],[0,180,220,200],[80,220,80,200],[255,200,0,200],[255,50,0,200]];
  const heatLayer = new HeatmapLayer({
    id: "heat", data: mapData,
    getPosition: (d: MapPoint) => d.position,
    getWeight: (d: MapPoint) => d.value,
    radiusPixels: 40, colorRange: colorRange as any,
    intensity: 1, threshold: 0.03,
  });
  const markerLayer = new ScatterplotLayer({
    id: "marker", data: clicked ? [clicked] : [],
    getPosition: (d: ClickedPoint) => [d.lon, d.lat],
    getFillColor: [0, 210, 132, 220],
    getLineColor: [255, 255, 255, 200],
    getLineWidth: 2, lineWidthMinPixels: 2,
    getRadius: 60000, radiusMinPixels: 7, stroked: true,
  });

  function CompareTimeInputs({ label, value, onChange }: {
    label: string; value: CompareTime; onChange: (v: CompareTime) => void;
  }) {
    return (
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 10, color: "#00d084", marginBottom: 5, fontWeight: 700, fontFamily: "'Space Mono', monospace", letterSpacing: 0.5 }}>{label}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
          {(["year","month","day","hour"] as const).map((k) => (
            <LabeledInput key={k} label={k.charAt(0).toUpperCase() + k.slice(1)}>
              <input
                type="number" style={inputStyle} value={value[k]}
                min={k==="month"?1:k==="day"?1:k==="hour"?0:1979}
                max={k==="month"?12:k==="day"?31:k==="hour"?18:2023}
                step={k==="hour"?6:1}
                onChange={(e) => onChange({ ...value, [k]: parseInt(e.target.value)||0 })}
              />
            </LabeledInput>
          ))}
        </div>
      </div>
    );
  }

  const showTimeSeries = series || seriesLoading;

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden",
      fontFamily: "'Syne', system-ui, sans-serif",
      background: "#040c06", color: "#e0ede2",
    }}>
      {/* ── Top bar ── */}
      <header style={{
        height: 48, flexShrink: 0,
        display: "flex", alignItems: "center",
        background: "rgba(4,12,6,0.98)",
        borderBottom: "1px solid rgba(0,210,132,0.1)",
        padding: "0 20px", gap: 16, zIndex: 20,
        boxShadow: "0 1px 20px rgba(0,0,0,0.5)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 28, height: 28, borderRadius: "50%",
            background: "radial-gradient(circle at 35% 35%, #00e89a, #006040)",
            boxShadow: "0 0 12px rgba(0,210,132,0.4)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 14,
          }}>🌿</div>
          <span style={{ fontSize: 15, fontWeight: 800, color: "#00e89a", letterSpacing: -0.5, fontFamily: "'Syne', sans-serif" }}>
            PyClima<span style={{ color: "#4a9e7a" }}>Explorer</span>
          </span>
        </div>
        <div style={{ width: 1, height: 20, background: "rgba(0,210,132,0.1)" }} />
        <span style={{ fontSize: 11, color: "#2d5c40", fontFamily: "'Space Mono', monospace", letterSpacing: 0.5 }}>
          ERA5 REANALYSIS · GLOBAL CLIMATE DATA
        </span>
        <div style={{ flex: 1 }} />
        {/* Live indicator */}
        {playing && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", background: "rgba(220,50,50,0.1)", border: "1px solid rgba(220,50,50,0.3)", borderRadius: 20 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#ff5555", boxShadow: "0 0 6px #ff5555", animation: "climaPulse 1s infinite" }} />
            <span style={{ fontSize: 10, color: "#ff8080", fontFamily: "'Space Mono', monospace", letterSpacing: 1 }}>LIVE</span>
          </div>
        )}
        <div style={{
          fontSize: 12, color: "#3d6645", fontFamily: "'Space Mono', monospace",
          background: "rgba(0,0,0,0.3)", padding: "5px 12px",
          borderRadius: 20, border: "1px solid rgba(0,210,132,0.08)",
        }}>
          {year}-{pad(month)}-{pad(day)} · {pad(hour)}:00 UTC
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* ── SIDEBAR ── */}
        <aside style={{
          width: 272, display: "flex", flexDirection: "column",
          background: "rgba(4,10,6,0.98)",
          borderRight: "1px solid rgba(0,210,132,0.08)",
          overflowY: "auto", flexShrink: 0, zIndex: 10,
        }}>
          <SidebarSection title="View Mode">
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              <ModeButton active={viewMode==="heatmap"} onClick={()=>setViewMode("heatmap")} icon="🌡️" label="Heatmap" />
              <ModeButton active={viewMode==="3d"}      onClick={()=>setViewMode("3d")}      icon="🌐" label="Globe" />
              <ModeButton active={viewMode==="wind"}    onClick={()=>setViewMode("wind")}    icon="💨" label="Wind" />
              <ModeButton active={viewMode==="anomaly"} onClick={()=>setViewMode("anomaly")} icon="📊" label="Anomaly" />
              <ModeButton active={viewMode==="compare"} onClick={()=>setViewMode("compare")} icon="🔀" label="Compare" />
            </div>
          </SidebarSection>

          <SidebarSection title="Variable">
            <select style={{ ...inputStyle, cursor: "pointer" }} value={variable} onChange={(e) => setVariable(e.target.value)}>
              {(metadata?.variables ?? []).map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </SidebarSection>

          {viewMode !== "compare" && (
            <SidebarSection title="Time">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                <LabeledInput label="Year">
                  <input type="number" style={inputStyle} value={year}
                    min={metadata?.years[0]??1979} max={metadata?.years[metadata.years.length-1]??2023}
                    onChange={(e) => setYear(parseInt(e.target.value))} />
                </LabeledInput>
                <LabeledInput label="Month">
                  <input type="number" style={inputStyle} value={month} min={1} max={12}
                    onChange={(e) => setMonth(parseInt(e.target.value))} />
                </LabeledInput>
                <LabeledInput label="Day">
                  <input type="number" style={inputStyle} value={day} min={1} max={31}
                    onChange={(e) => setDay(parseInt(e.target.value))} />
                </LabeledInput>
                <LabeledInput label="Hour UTC">
                  <input type="number" style={inputStyle} value={hour} min={0} max={18} step={6}
                    onChange={(e) => setHour(parseInt(e.target.value))} />
                </LabeledInput>
              </div>
            </SidebarSection>
          )}

          {viewMode === "compare" && (
            <SidebarSection title="Compare Timestamps">
              <CompareTimeInputs label="Time A" value={compareA} onChange={setCompareA} />
              <CompareTimeInputs label="Time B" value={compareB} onChange={setCompareB} />
            </SidebarSection>
          )}

          <SidebarSection title="Controls">
            {viewMode !== "compare" && (
              <button style={{
                width: "100%", padding: "10px",
                background: playing
                  ? "linear-gradient(135deg, rgba(220,50,50,0.15) 0%, rgba(180,20,20,0.08) 100%)"
                  : "linear-gradient(135deg, rgba(0,210,132,0.13) 0%, rgba(0,150,100,0.06) 100%)",
                border: `1px solid ${playing ? "rgba(220,50,50,0.4)" : "rgba(0,210,132,0.3)"}`,
                borderRadius: 9, color: playing ? "#ff6b6b" : "#00d084",
                fontWeight: 700, fontSize: 12, cursor: "pointer", marginBottom: 7,
                fontFamily: "'Space Mono', monospace", transition: "all 0.2s", letterSpacing: 0.5,
                boxShadow: playing ? "0 0 14px rgba(220,50,50,0.1)" : "0 0 14px rgba(0,210,132,0.08)",
              }} onClick={() => setPlaying(!playing)}>
                {playing ? "⏸  PAUSE" : "▶  PLAY TIMELINE"}
              </button>
            )}
            <button style={{
              width: "100%", padding: "10px",
              background: inspectMode
                ? "linear-gradient(135deg, rgba(120,80,220,0.18) 0%, rgba(80,40,180,0.08) 100%)"
                : "rgba(0,0,0,0.2)",
              border: `1px solid ${inspectMode ? "rgba(140,100,240,0.5)" : "rgba(0,210,132,0.1)"}`,
              borderRadius: 9, color: inspectMode ? "#c4a0ff" : "#3d6645",
              fontWeight: 700, fontSize: 12, cursor: "pointer",
              fontFamily: "'Space Mono', monospace", transition: "all 0.2s", letterSpacing: 0.5,
              boxShadow: inspectMode ? "0 0 14px rgba(120,80,220,0.15)" : "none",
            }} onClick={() => { setInspectMode(!inspectMode); if (inspectMode) { setSeries(null); setClicked(null); } }}>
              {inspectMode ? "🔍 INSPECT ON" : "🔍 INSPECT OFF"}
            </button>
          </SidebarSection>

          <SidebarSection title="Statistics">
            {loading ? (
              <div style={{ fontSize: 11, color: "#2d5040", fontFamily: "'Space Mono', monospace" }}>loading…</div>
            ) : stats ? (
              <div style={{ display: "flex", gap: 6 }}>
                <StatCard label="Min"  value={stats.min}  />
                <StatCard label="Mean" value={stats.mean} />
                <StatCard label="Max"  value={stats.max}  />
              </div>
            ) : (
              <div style={{ fontSize: 11, color: "#2d5040", fontFamily: "'Space Mono', monospace" }}>no data loaded</div>
            )}
          </SidebarSection>

          <SidebarSection title="Legend">
            <div style={{ fontSize: 10, color: "#2d5040", marginBottom: 5, fontFamily: "'Space Mono', monospace" }}>
              {isDiff ? "NEGATIVE ← ZERO → POSITIVE" : "LOW → HIGH INTENSITY"}
            </div>
            <div style={{
              height: 8, borderRadius: 4, marginBottom: 6,
              background: isDiff
                ? "linear-gradient(to right,#0044ff,#aabbff,#ffffff,#ffbbaa,#ff2200)"
                : "linear-gradient(to right,#0000b4,#00b4dc,#50dc50,#ffc800,#ff3200)",
              boxShadow: "0 0 10px rgba(0,210,132,0.1)",
            }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#2d5040", fontFamily: "'Space Mono', monospace" }}>
              {stats
                ? <><span>{stats.min.toFixed(1)}</span><span>{stats.mean.toFixed(1)}</span><span>{stats.max.toFixed(1)}</span></>
                : <><span>LOW</span><span>HIGH</span></>
              }
            </div>
          </SidebarSection>

          <SummaryPanel summary={summary} loading={summaryLoading} onRefresh={fetchSummary} />

          {clicked && (
            <SidebarSection title="Selected Point">
              <div style={{
                fontSize: 12, color: "#7fffc4", fontFamily: "'Space Mono', monospace",
                background: "rgba(0,210,132,0.06)", borderRadius: 8, padding: "8px 10px",
                border: "1px solid rgba(0,210,132,0.12)",
              }}>
                📍 {clicked.lat.toFixed(3)}°N · {clicked.lon.toFixed(3)}°E
              </div>
              <button style={{
                marginTop: 6, fontSize: 10, color: "#2d5040", background: "none",
                border: "none", cursor: "pointer", padding: 0,
                fontFamily: "'Space Mono', monospace", letterSpacing: 0.5,
              }} onClick={() => { setSeries(null); setClicked(null); }}>
                ✕ clear pin
              </button>
            </SidebarSection>
          )}

          {error && (
            <div style={{
              margin: "10px 14px", padding: "10px 12px",
              background: "rgba(220,50,50,0.08)", border: "1px solid rgba(220,50,50,0.25)",
              borderRadius: 10, fontSize: 11, color: "#ff8080",
              fontFamily: "'Space Mono', monospace", lineHeight: 1.6,
            }}>
              ⚠ {error}
            </div>
          )}
        </aside>

        {/* ── MAP / GLOBE ── */}
        <div style={{ flex: 1, position: "relative" }}>
          {/* Loading overlay */}
          {loading && (
            <div style={{
              position: "absolute", inset: 0, zIndex: 20,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "rgba(4,10,6,0.6)", backdropFilter: "blur(4px)",
              pointerEvents: "none",
            }}>
              <div style={{ textAlign: "center" }}>
                <div style={{
                  width: 52, height: 52, borderRadius: "50%",
                  border: "2px solid rgba(0,210,132,0.15)",
                  borderTopColor: "#00d084", margin: "0 auto 14px",
                  animation: "spin 1s linear infinite",
                }} />
                <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
                <div style={{ fontSize: 13, color: "#00d084", fontFamily: "'Space Mono', monospace", letterSpacing: 1 }}>
                  LOADING DATA…
                </div>
              </div>
            </div>
          )}

          {/* Mode badge */}
          <div style={{
            position: "absolute", top: 14, left: 14, zIndex: 15,
            background: "rgba(4,10,6,0.9)", border: "1px solid rgba(0,210,132,0.2)",
            borderRadius: 20, padding: "6px 14px", fontSize: 11, color: "#00d084",
            backdropFilter: "blur(8px)", fontFamily: "'Space Mono', monospace",
            letterSpacing: 0.5, display: "flex", alignItems: "center", gap: 8,
            boxShadow: "0 2px 16px rgba(0,0,0,0.4)",
          }}>
            {viewMode==="heatmap" && "🌡️ HEATMAP"}
            {viewMode==="3d"      && "🌐 GLOBE"}
            {viewMode==="wind"    && "💨 WIND"}
            {viewMode==="anomaly" && "📊 ANOMALY"}
            {viewMode==="compare" && "🔀 COMPARE"}
            <span style={{ color: "#2d5c40" }}>· {variable}</span>
            {inspectMode && <span style={{ color: "#c4a0ff" }}>· 🔍</span>}
          </div>

          {inspectMode && !clicked && (
            <div style={{
              position: "absolute", bottom: 24, left: "50%", transform: "translateX(-50%)",
              zIndex: 15, background: "rgba(70,30,160,0.88)", borderRadius: 24,
              padding: "9px 22px", fontSize: 12, color: "#ddd0ff",
              backdropFilter: "blur(8px)", whiteSpace: "nowrap",
              fontFamily: "'Space Mono', monospace", letterSpacing: 0.5,
              border: "1px solid rgba(140,100,240,0.3)",
              boxShadow: "0 4px 20px rgba(70,30,160,0.4)",
            }}>
              CLICK MAP TO VIEW TIME SERIES
            </div>
          )}

          {/* ── Globe 3D or DeckGL ── */}
          {viewMode === "3d" ? (
            <Globe3D mapData={mapData} stats={stats} isDiff={isDiff} />
          ) : (
            <DeckGL
              viewState={viewState}
              controller={true}
              layers={[heatLayer, markerLayer]}
              onViewStateChange={({ viewState: vs }: any) => setViewState(vs)}
              onClick={(info: any) => {
                if (!inspectMode || !info.coordinate) return;
                const [lon, lat] = info.coordinate;
                fetchSeries(lon, lat);
              }}
              style={{ position: "absolute", inset: 0 }}
              getCursor={({ isDragging }: any) => inspectMode ? "crosshair" : isDragging ? "grabbing" : "grab"}
            >
              <Map mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" />
            </DeckGL>
          )}
        </div>
      </div>

      {/* ── TIME SERIES PANEL ── */}
      {showTimeSeries && (
        <div style={{
          height: 280, flexShrink: 0, zIndex: 5,
          background: "rgba(4,10,6,0.98)",
          borderTop: "1px solid rgba(0,210,132,0.12)",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "11px 22px 0",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{
                width: 3, height: 22, background: "linear-gradient(to bottom, #00e89a, #004030)",
                borderRadius: 2,
              }} />
              <div>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#7fffc4", fontFamily: "'Syne', sans-serif" }}>{variable}</span>
                <span style={{ fontSize: 11, color: "#2d5040", marginLeft: 8, fontFamily: "'Space Mono', monospace" }}>TIME SERIES</span>
                {clicked && (
                  <span style={{ fontSize: 11, color: "#2d5040", marginLeft: 10, fontFamily: "'Space Mono', monospace" }}>
                    @ {clicked.lat.toFixed(3)}°N · {clicked.lon.toFixed(3)}°E
                  </span>
                )}
              </div>
            </div>
            <button onClick={() => { setSeries(null); setClicked(null); setSeriesLoading(false); }}
              style={{
                background: "rgba(0,0,0,0.2)", border: "1px solid rgba(0,210,132,0.1)",
                borderRadius: 8, color: "#2d5040", cursor: "pointer",
                fontSize: 12, padding: "5px 10px", fontFamily: "'Space Mono', monospace",
                transition: "all 0.2s",
              }}>
              ✕
            </button>
          </div>
          {seriesLoading ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#2d5040", fontSize: 12, fontFamily: "'Space Mono', monospace", letterSpacing: 1 }}>
              FETCHING TIME SERIES…
            </div>
          ) : series ? (
            <Plot
              data={[{
                x: series.time, y: series.values,
                type: "scatter", mode: "lines",
                line: { color: "#00d084", width: 1.8 },
                fill: "tozeroy", fillcolor: "rgba(0,210,132,0.07)",
              }]}
              layout={{
                height: 230,
                margin: { t: 10, l: 58, r: 22, b: 52 },
                paper_bgcolor: "transparent", plot_bgcolor: "transparent",
                font: { color: "#3d6645", size: 10, family: "Space Mono, monospace" },
                xaxis: {
                  title: { text: "TIME", font: { size: 10, color: "#2d5040" } },
                  gridcolor: "rgba(0,210,132,0.06)", linecolor: "rgba(0,210,132,0.12)",
                  tickfont: { size: 9 }, tickcolor: "rgba(0,210,132,0.2)",
                },
                yaxis: {
                  title: { text: variable, font: { size: 10, color: "#2d5040" } },
                  gridcolor: "rgba(0,210,132,0.06)", linecolor: "rgba(0,210,132,0.12)",
                  tickfont: { size: 9 }, tickcolor: "rgba(0,210,132,0.2)",
                },
              }}
              config={{ responsive: true, displayModeBar: false }}
              style={{ width: "100%" }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
