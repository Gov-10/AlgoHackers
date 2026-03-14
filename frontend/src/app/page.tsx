
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

// ─── Presentational components ────────────────────────────────────────────────
function StatCard({ label, value }: { label: string; value: number | null }) {
  return (
    <div style={{
      background: "rgba(0,210,132,0.06)",
      border: "1px solid rgba(0,210,132,0.15)",
      borderRadius: 8, padding: "8px 12px", flex: 1, minWidth: 0,
    }}>
      <div style={{ fontSize: 10, color: "#6b8f72", textTransform: "uppercase", letterSpacing: 1, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: "#b8f5c8", fontVariantNumeric: "tabular-nums" }}>
        {value != null ? value.toFixed(2) : "—"}
      </div>
    </div>
  );
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: "14px 16px", borderBottom: "1px solid rgba(0,210,132,0.08)" }}>
      <div style={{ fontSize: 10, color: "#4a7a55", textTransform: "uppercase", letterSpacing: 1.5, fontWeight: 700, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function LabeledInput({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: "#6b8f72", marginBottom: 3 }}>{label}</div>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "rgba(0,0,0,0.35)",
  border: "1px solid rgba(0,210,132,0.2)",
  borderRadius: 6, color: "#c8e6cb",
  padding: "6px 8px", fontSize: 13,
  boxSizing: "border-box", outline: "none",
};

function ModeButton({ active, onClick, icon, label }: {
  active: boolean; onClick: () => void; icon: string; label: string;
}) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: "7px 4px",
      background: active ? "rgba(0,210,132,0.18)" : "rgba(0,0,0,0.25)",
      border: `1px solid ${active ? "rgba(0,210,132,0.5)" : "rgba(0,210,132,0.1)"}`,
      borderRadius: 6, color: active ? "#00d084" : "#6b8f72",
      cursor: "pointer", fontSize: 11,
      display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
      transition: "all 0.15s", fontFamily: "inherit",
    }}>
      <span style={{ fontSize: 16 }}>{icon}</span>
      {label}
    </button>
  );
}

function SummaryPanel({ summary, loading, onRefresh }: {
  summary: string | null; loading: boolean; onRefresh: () => void;
}) {
  return (
    <div style={{
      margin: "12px 16px",
      background: "rgba(0,210,132,0.05)",
      border: "1px solid rgba(0,210,132,0.18)",
      borderRadius: 10, padding: "12px 14px", minHeight: 70,
    }}>
      <style>{`
        @keyframes climaPulse {
          0%, 100% { opacity: 0.2; transform: scale(0.8); }
          50%       { opacity: 1;   transform: scale(1.15); }
        }
      `}</style>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: "#4a7a55", textTransform: "uppercase", letterSpacing: 1.5, fontWeight: 700 }}>
          🤖 AI Summary
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          style={{
            background: "none", border: "1px solid rgba(0,210,132,0.2)",
            borderRadius: 5, color: loading ? "#4a7a55" : "#00d084",
            fontSize: 10, cursor: loading ? "default" : "pointer",
            padding: "3px 8px", fontFamily: "inherit", transition: "all 0.15s",
          }}
        >
          {loading ? "Thinking…" : "↺ Refresh"}
        </button>
      </div>

      {loading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", gap: 4 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{
                width: 5, height: 5, borderRadius: "50%", background: "#00d084", opacity: 0.4,
                animation: `climaPulse 1.2s ease-in-out ${i * 0.2}s infinite`,
              }} />
            ))}
          </div>
          <span style={{ fontSize: 12, color: "#4a7a55" }}>Analyzing current view…</span>
        </div>
      ) : summary ? (
        <p style={{ fontSize: 12,
  color: "#b8d4bb",
  lineHeight: 1.7,
  margin: 0,
  maxHeight: 120,
  overflowY: "auto",
  paddingRight: 4,
  wordBreak: "break-word",
  overflowWrap: "anywhere",
  scrollbarWidth: "thin" }}>{summary}</p>
      ) : (
        <p style={{ fontSize: 12, color: "#4a7a55", margin: 0, fontStyle: "italic" }}>
          Click ↺ Refresh to get an AI explanation of what you're looking at.
        </p>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Page() {

  // ── State ────────────────────────────────────────────────────────────────────
  const [metadata, setMetadata]         = useState<Metadata | null>(null);
  const [variable, setVariable]         = useState("");
  const [year, setYear]                 = useState(2022);
  const [month, setMonth]               = useState(1);
  const [day, setDay]                   = useState(1);
  const [hour, setHour]                 = useState(0);
  const [viewMode, setViewMode]         = useState<ViewMode>("heatmap");
  const [inspectMode, setInspectMode]   = useState(false);
  const [playing, setPlaying]           = useState(false);
  const [viewState, setViewState]       = useState({ longitude: 0, latitude: 20, zoom: 2, pitch: 0, bearing: 0 });
  const [mapData, setMapData]           = useState<MapPoint[]>([]);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [stats, setStats]               = useState<{ min: number; max: number; mean: number } | null>(null);
  const [series, setSeries]             = useState<TimeSeriesData | null>(null);
  const [clicked, setClicked]           = useState<ClickedPoint | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [compareA, setCompareA]         = useState<CompareTime>({ year: 2020, month: 1, day: 1, hour: 0 });
  const [compareB, setCompareB]         = useState<CompareTime>({ year: 2022, month: 1, day: 1, hour: 0 });
  const [summary, setSummary]           = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const playRef = useRef(playing);
  playRef.current = playing;

  // ─── Callbacks — all defined BEFORE any useEffect that uses them ─────────────

  const loadTile = useCallback(async () => {
    if (!variable) return;
    setLoading(true);
    setError(null);
    try {
      if (viewMode === "anomaly") {
        const url = `${API}/anomaly?variable=${variable}&year=${year}&month=${month}&day=${day}&hour=${hour}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        const tile = await res.json();
        const pts = flattenTile(tile);
        setMapData(pts); setStats(calcStats(pts));
        return;
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
        setMapData(pts); setStats(calcStats(pts));
        return;
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
    setSeriesLoading(true);
    setSeries(null);
    setClicked({ lat, lon });
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
    setSummaryLoading(true);
    setSummary(null);
    try {
      const body: Record<string, any> = {
        variable, view_mode: viewMode,
        year, month, day, hour,
        stat_min: stats?.min ?? null,
        stat_max: stats?.max ?? null,
        stat_mean: stats?.mean ?? null,
      };
      if (clicked && series) {
        body.clicked_lat = clicked.lat;
        body.clicked_lon = clicked.lon;
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

  // ─── Effects — all after callbacks ───────────────────────────────────────────

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
      : { ...vs, pitch: 0,  bearing: 0  }
    );
  }, [viewMode]);

  // Auto-summary when tile finishes loading (skip during animation playback)
  useEffect(() => {
    if (!playing && stats) fetchSummary();
  }, [stats, playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Deck.gl layers ───────────────────────────────────────────────────────────
  const isDiff = viewMode === "compare" || viewMode === "anomaly";

  const colorRange = isDiff
    ? [[0,0,255,200],[100,150,255,200],[255,255,255,200],[255,150,100,200],[255,0,0,200]]
    : [[0,0,180,200],[0,180,220,200],[80,220,80,200],[255,200,0,200],[255,50,0,200]];

  const heatLayer = new HeatmapLayer({
    id: "heat",
    data: mapData,
    getPosition: (d: MapPoint) => d.position,
    getWeight: (d: MapPoint) => d.value,
    radiusPixels: viewMode === "3d" ? 60 : 40,
    colorRange: colorRange as any,
    intensity: 1,
    threshold: 0.03,
  });

  const markerLayer = new ScatterplotLayer({
    id: "marker",
    data: clicked ? [clicked] : [],
    getPosition: (d: ClickedPoint) => [d.lon, d.lat],
    getFillColor: [0, 210, 132, 220],
    getLineColor: [255, 255, 255, 200],
    getLineWidth: 2, lineWidthMinPixels: 2,
    getRadius: 60000, radiusMinPixels: 7,
    stroked: true,
  });

  // ─── Compare time input (no hooks, safe inside render) ───────────────────────
  function CompareTimeInputs({ label, value, onChange }: {
    label: string; value: CompareTime; onChange: (v: CompareTime) => void;
  }) {
    return (
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: "#00d084", marginBottom: 4, fontWeight: 600 }}>{label}</div>
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

  // ─── Render ───────────────────────────────────────────────────────────────────
  const showTimeSeries = series || seriesLoading;

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100vh", overflow:"hidden", fontFamily:"'DM Sans', system-ui, sans-serif", background:"#080f0a", color:"#e8f0e9" }}>

      <div style={{ display:"flex", flex:1, overflow:"hidden" }}>

        {/* ── SIDEBAR ── */}
        <aside style={{
          width:280, display:"flex", flexDirection:"column",
          background:"rgba(8,18,10,0.97)",
          borderRight:"1px solid rgba(0,210,132,0.12)",
          overflowY:"auto", flexShrink:0, zIndex:10,
        }}>
          {/* Logo */}
          <div style={{ padding:"18px 16px 14px", borderBottom:"1px solid rgba(0,210,132,0.1)" }}>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:2 }}>
              <span style={{ fontSize:20 }}>🌿</span>
              <span style={{ fontSize:17, fontWeight:700, color:"#00d084", letterSpacing:-0.5 }}>PyClimaExplorer</span>
            </div>
            <div style={{ fontSize:11, color:"#4a7a55" }}>ERA5 Reanalysis · Global Climate Data</div>
          </div>

          <SidebarSection title="View Mode">
            <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
              <ModeButton active={viewMode==="heatmap"} onClick={()=>setViewMode("heatmap")} icon="🌡️" label="Heatmap" />
              <ModeButton active={viewMode==="3d"}      onClick={()=>setViewMode("3d")}      icon="🌐" label="3D Globe" />
              <ModeButton active={viewMode==="wind"}    onClick={()=>setViewMode("wind")}    icon="💨" label="Wind" />
              <ModeButton active={viewMode==="anomaly"} onClick={()=>setViewMode("anomaly")} icon="📊" label="Anomaly" />
              <ModeButton active={viewMode==="compare"} onClick={()=>setViewMode("compare")} icon="🔀" label="Compare" />
            </div>
          </SidebarSection>

          <SidebarSection title="Variable">
            <select style={{ ...inputStyle, cursor:"pointer" }} value={variable} onChange={(e)=>setVariable(e.target.value)}>
              {(metadata?.variables ?? []).map((v) => (
                <option key={v} value={v} style={{ background:"#0d1f10" }}>{v}</option>
              ))}
            </select>
          </SidebarSection>

          {viewMode !== "compare" && (
            <SidebarSection title="Time">
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
                <LabeledInput label="Year">
                  <input type="number" style={inputStyle} value={year}
                    min={metadata?.years[0]??1979} max={metadata?.years[metadata.years.length-1]??2023}
                    onChange={(e)=>setYear(parseInt(e.target.value))} />
                </LabeledInput>
                <LabeledInput label="Month">
                  <input type="number" style={inputStyle} value={month} min={1} max={12}
                    onChange={(e)=>setMonth(parseInt(e.target.value))} />
                </LabeledInput>
                <LabeledInput label="Day">
                  <input type="number" style={inputStyle} value={day} min={1} max={31}
                    onChange={(e)=>setDay(parseInt(e.target.value))} />
                </LabeledInput>
                <LabeledInput label="Hour (UTC)">
                  <input type="number" style={inputStyle} value={hour} min={0} max={18} step={6}
                    onChange={(e)=>setHour(parseInt(e.target.value))} />
                </LabeledInput>
              </div>
              <div style={{ marginTop:6, fontSize:12, color:"#4a7a55", fontVariantNumeric:"tabular-nums" }}>
                📅 {year}-{pad(month)}-{pad(day)} {pad(hour)}:00 UTC
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
                width:"100%", padding:"9px",
                background:playing?"rgba(220,50,50,0.15)":"rgba(0,210,132,0.12)",
                border:`1px solid ${playing?"rgba(220,50,50,0.4)":"rgba(0,210,132,0.35)"}`,
                borderRadius:7, color:playing?"#ff6b6b":"#00d084",
                fontWeight:600, fontSize:13, cursor:"pointer", marginBottom:8,
                fontFamily:"inherit", transition:"all 0.15s",
              }} onClick={()=>setPlaying(!playing)}>
                {playing ? "⏸ Pause Animation" : "▶ Play Timeline"}
              </button>
            )}
            <button style={{
              width:"100%", padding:"9px",
              background:inspectMode?"rgba(120,80,220,0.18)":"rgba(0,0,0,0.25)",
              border:`1px solid ${inspectMode?"rgba(120,80,220,0.5)":"rgba(0,210,132,0.15)"}`,
              borderRadius:7, color:inspectMode?"#b48ef5":"#6b8f72",
              fontWeight:600, fontSize:13, cursor:"pointer",
              fontFamily:"inherit", transition:"all 0.15s",
            }} onClick={()=>{ setInspectMode(!inspectMode); if(inspectMode){setSeries(null);setClicked(null);} }}>
              {inspectMode ? "🔍 Inspect ON — click map" : "🔍 Enable Inspect Mode"}
            </button>
          </SidebarSection>

          <SidebarSection title="Data Statistics">
            {loading ? (
              <div style={{ fontSize:12, color:"#4a7a55" }}>Loading…</div>
            ) : stats ? (
              <div style={{ display:"flex", gap:6 }}>
                <StatCard label="Min"  value={stats.min}  />
                <StatCard label="Mean" value={stats.mean} />
                <StatCard label="Max"  value={stats.max}  />
              </div>
            ) : (
              <div style={{ fontSize:12, color:"#4a7a55" }}>No data loaded</div>
            )}
          </SidebarSection>

          <SidebarSection title="Legend">
            <div style={{ fontSize:11, color:"#4a7a55", marginBottom:4 }}>
              {isDiff ? "Negative → Zero → Positive" : "Low → High"}
            </div>
            <div style={{
              height:10, borderRadius:5, marginBottom:4,
              background: isDiff
                ? "linear-gradient(to right,#0000ff,#aaaaff,#ffffff,#ffaaaa,#ff0000)"
                : "linear-gradient(to right,#0000b4,#00b4dc,#50dc50,#ffc800,#ff3200)",
            }}/>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"#4a7a55" }}>
              {stats
                ? <><span>{stats.min.toFixed(1)}</span><span>{stats.mean.toFixed(1)}</span><span>{stats.max.toFixed(1)}</span></>
                : <><span>Low</span><span>High</span></>
              }
            </div>
          </SidebarSection>

          {/* AI Summary — defined before effects, placed here in JSX */}
          <SummaryPanel summary={summary} loading={summaryLoading} onRefresh={fetchSummary} />

          {clicked && (
            <SidebarSection title="Selected Point">
              <div style={{ fontSize:12, color:"#b8f5c8" }}>
                📍 {clicked.lat.toFixed(3)}°N, {clicked.lon.toFixed(3)}°E
              </div>
              <button style={{ marginTop:6, fontSize:11, color:"#6b8f72", background:"none", border:"none", cursor:"pointer", padding:0, fontFamily:"inherit" }}
                onClick={()=>{ setSeries(null); setClicked(null); }}>
                ✕ Clear pin
              </button>
            </SidebarSection>
          )}

          {error && (
            <div style={{ margin:"10px 16px", padding:"10px 12px", background:"rgba(220,50,50,0.1)", border:"1px solid rgba(220,50,50,0.3)", borderRadius:8, fontSize:12, color:"#ff8080" }}>
              ⚠ {error}
            </div>
          )}
        </aside>

        {/* ── MAP ── */}
        <div style={{ flex:1, position:"relative" }}>
          {loading && (
            <div style={{
              position:"absolute", inset:0, zIndex:20,
              display:"flex", alignItems:"center", justifyContent:"center",
              background:"rgba(8,15,10,0.55)", backdropFilter:"blur(2px)",
              pointerEvents:"none",
            }}>
              <div style={{ textAlign:"center" }}>
                <div style={{ fontSize:28, marginBottom:10 }}>🌿</div>
                <div style={{ fontSize:14, color:"#00d084" }}>Loading climate data…</div>
              </div>
            </div>
          )}

          <div style={{
            position:"absolute", top:14, left:14, zIndex:15,
            background:"rgba(8,18,10,0.88)", border:"1px solid rgba(0,210,132,0.25)",
            borderRadius:8, padding:"6px 12px", fontSize:12, color:"#00d084",
            backdropFilter:"blur(6px)",
          }}>
            {viewMode==="heatmap" && `🌡️ Heatmap · ${variable}`}
            {viewMode==="3d"      && `🌐 3D Globe · ${variable}`}
            {viewMode==="wind"    && `💨 Wind Speed`}
            {viewMode==="anomaly" && `📊 Anomaly · ${variable}`}
            {viewMode==="compare" && `🔀 Compare · ${variable}`}
            {inspectMode && <span style={{ marginLeft:10, color:"#b48ef5" }}>· 🔍 Inspect</span>}
          </div>

          {viewMode !== "compare" && (
            <div style={{
              position:"absolute", top:14, right:14, zIndex:15,
              background:"rgba(8,18,10,0.88)", border:"1px solid rgba(0,210,132,0.15)",
              borderRadius:8, padding:"6px 12px", fontSize:12, color:"#6b8f72",
              backdropFilter:"blur(6px)", fontVariantNumeric:"tabular-nums",
            }}>
              {year}-{pad(month)}-{pad(day)} {pad(hour)}:00 UTC
            </div>
          )}

          {inspectMode && !clicked && (
            <div style={{
              position:"absolute", bottom:20, left:"50%", transform:"translateX(-50%)",
              zIndex:15, background:"rgba(90,50,200,0.85)", borderRadius:20,
              padding:"8px 18px", fontSize:13, color:"#e0d0ff",
              backdropFilter:"blur(6px)", whiteSpace:"nowrap",
            }}>
              Click anywhere on the map to view the time series
            </div>
          )}

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
            style={{ position:"absolute", inset:0 }}
            getCursor={({ isDragging }: any) => inspectMode ? "crosshair" : isDragging ? "grabbing" : "grab"}
          >
            <Map mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" />
          </DeckGL>
        </div>
      </div>

      {/* ── TIME SERIES PANEL ── */}
      {showTimeSeries && (
        <div style={{
          height:280, background:"rgba(8,18,10,0.97)",
          borderTop:"1px solid rgba(0,210,132,0.2)",
          display:"flex", flexDirection:"column", flexShrink:0, zIndex:5,
        }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 20px 0" }}>
            <div>
              <span style={{ fontSize:14, fontWeight:600, color:"#b8f5c8" }}>{variable} Time Series</span>
              {clicked && (
                <span style={{ fontSize:12, color:"#4a7a55", marginLeft:10 }}>
                  at {clicked.lat.toFixed(3)}°N, {clicked.lon.toFixed(3)}°E
                </span>
              )}
            </div>
            <button onClick={()=>{ setSeries(null); setClicked(null); setSeriesLoading(false); }}
              style={{ background:"none", border:"none", color:"#4a7a55", cursor:"pointer", fontSize:18, padding:0, lineHeight:1 }}>
              ✕
            </button>
          </div>

          {seriesLoading ? (
            <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", color:"#4a7a55", fontSize:13 }}>
              Fetching time series…
            </div>
          ) : series ? (
            <Plot
              data={[{
                x: series.time, y: series.values,
                type: "scatter", mode: "lines",
                line: { color:"#00d084", width:1.5 },
                fill: "tozeroy", fillcolor: "rgba(0,210,132,0.08)",
              }]}
              layout={{
                height: 230,
                margin: { t:10, l:55, r:20, b:50 },
                paper_bgcolor: "transparent", plot_bgcolor: "transparent",
                font: { color:"#6b8f72", size:11, family:"DM Sans, system-ui, sans-serif" },
                xaxis: { title:{text:"Time",font:{size:11}}, gridcolor:"rgba(0,210,132,0.08)", linecolor:"rgba(0,210,132,0.15)", tickfont:{size:10} },
                yaxis: { title:{text:variable,font:{size:11}}, gridcolor:"rgba(0,210,132,0.08)", linecolor:"rgba(0,210,132,0.15)", tickfont:{size:10} },
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
