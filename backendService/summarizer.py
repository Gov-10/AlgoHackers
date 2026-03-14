# summarizer.py
# Drop this file next to your main.py and add the router to your FastAPI app.
#
# pip install langchain langchain-anthropic
# Add to .env:  ANTHROPIC_API_KEY=sk-ant-...
#
# In main.py add:
#   from summarizer import router as summarizer_router
#   app.include_router(summarizer_router)

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
import os
from dotenv import load_dotenv
from langchain_groq import ChatGroq
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
load_dotenv()
router = APIRouter()

# ─── Schema ──────────────────────────────────────────────────────────────────

class SummarizeRequest(BaseModel):
    # What the user is currently looking at
    variable: str                        # e.g. "t2m"
    view_mode: str                       # heatmap | 3d | wind | anomaly | compare
    year: Optional[int] = None
    month: Optional[int] = None
    day: Optional[int] = None
    hour: Optional[int] = None

    # Stats computed on the frontend from the current tile
    stat_min: Optional[float] = None
    stat_max: Optional[float] = None
    stat_mean: Optional[float] = None

    # For inspect mode: the clicked point's timeseries
    clicked_lat: Optional[float] = None
    clicked_lon: Optional[float] = None
    timeseries_times: Optional[list[str]] = None   # first + last few entries is fine
    timeseries_values: Optional[list[float]] = None

    # For compare mode
    time_a: Optional[str] = None         # e.g. "2020-01-01 00:00"
    time_b: Optional[str] = None

    # Optional: region the user is zoomed into
    region_hint: Optional[str] = None    # e.g. "South Asia" — frontend can pass this

# ─── Variable metadata (helps the LLM give better explanations) ───────────────

VARIABLE_META = {
    "t2m":   {"name": "2m Air Temperature",         "unit": "K",     "description": "air temperature 2 metres above the surface"},
    "tp":    {"name": "Total Precipitation",         "unit": "m",     "description": "accumulated liquid and frozen water falling to Earth's surface"},
    "u10":   {"name": "10m U-Wind Component",        "unit": "m/s",   "description": "eastward component of wind at 10m height"},
    "v10":   {"name": "10m V-Wind Component",        "unit": "m/s",   "description": "northward component of wind at 10m height"},
    "sp":    {"name": "Surface Pressure",            "unit": "Pa",    "description": "pressure of the atmosphere at the surface"},
    "msl":   {"name": "Mean Sea-Level Pressure",     "unit": "Pa",    "description": "atmospheric pressure reduced to sea level"},
    "d2m":   {"name": "2m Dewpoint Temperature",     "unit": "K",     "description": "temperature to which air must be cooled to become saturated with water vapour"},
    "tcc":   {"name": "Total Cloud Cover",           "unit": "0–1",   "description": "fraction of the sky covered by cloud"},
    "ssrd":  {"name": "Surface Solar Radiation",     "unit": "J/m²",  "description": "amount of solar radiation reaching the Earth's surface"},
    "wind_speed": {"name": "Wind Speed",             "unit": "m/s",   "description": "magnitude of horizontal wind at 10m"},
}

def describe_variable(var: str) -> str:
    meta = VARIABLE_META.get(var)
    if meta:
        return f"{meta['name']} ({var}) measured in {meta['unit']} — {meta['description']}"
    return var  # fallback: just use the raw name

# ─── Prompt ───────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are a friendly climate scientist assistant inside a web app called PyClimaExplorer.
Users are exploring ERA5 reanalysis climate data on an interactive map.
They may or may not have a scientific background, so explain things clearly but don't over-simplify.

Your job: given what the user is currently viewing, write a short, helpful summary (3–5 sentences) that:
1. Tells them what variable/mode they are looking at and what it means physically
2. Interprets the current statistics (min/mean/max) in plain English — mention whether values seem high/low/normal
3. If a time series is provided, describe the trend (rising, falling, seasonal pattern, anomaly spike, etc.)
4. If compare or anomaly mode, explain what the colours mean (blue = negative/cooler, red = positive/warmer)
5. End with one actionable tip: what to look at next or what the pattern might indicate

Keep it under 120 words. No bullet points. Write as flowing prose. Don't start with "This map shows" — be more engaging."""

USER_TEMPLATE = """The user is currently viewing:

Variable: {variable_description}
View mode: {view_mode}
{time_context}
{stats_context}
{timeseries_context}
{compare_context}
{region_context}

Write the summary now."""

# ─── Chain ────────────────────────────────────────────────────────────────────

def build_chain():
    llm = ChatGroq(
    model="llama-3.3-70b-versatile",
    temperature=0.4,
    max_tokens=250,
    groq_api_key=os.getenv("GROQ_API_KEY")
)
    prompt = ChatPromptTemplate.from_messages([
        ("system", SYSTEM_PROMPT),
        ("human", USER_TEMPLATE),
    ])
    return prompt | llm | StrOutputParser()

chain = build_chain()

# ─── Helpers ──────────────────────────────────────────────────────────────────

def _time_context(req: SummarizeRequest) -> str:
    if req.year and req.month and req.day is not None and req.hour is not None:
        return f"Timestamp: {req.year}-{str(req.month).zfill(2)}-{str(req.day).zfill(2)} {str(req.hour).zfill(2)}:00 UTC"
    return ""

def _stats_context(req: SummarizeRequest) -> str:
    parts = []
    if req.stat_min is not None: parts.append(f"min={req.stat_min:.3g}")
    if req.stat_mean is not None: parts.append(f"mean={req.stat_mean:.3g}")
    if req.stat_max is not None: parts.append(f"max={req.stat_max:.3g}")
    if parts:
        unit = VARIABLE_META.get(req.variable, {}).get("unit", "")
        return f"Current tile statistics ({unit}): {', '.join(parts)}"
    return ""

def _timeseries_context(req: SummarizeRequest) -> str:
    if not req.timeseries_values or not req.timeseries_times:
        return ""
    vals = req.timeseries_values
    times = req.timeseries_times
    # Send a compact summary: first/last timestamps + sampled values (max 12 points)
    n = len(vals)
    if n > 12:
        step = n // 12
        sampled_vals = [round(vals[i], 3) for i in range(0, n, step)][:12]
        sampled_times = [times[i] for i in range(0, n, step)][:12]
    else:
        sampled_vals = [round(v, 3) for v in vals]
        sampled_times = times

    coord = ""
    if req.clicked_lat is not None and req.clicked_lon is not None:
        coord = f" at ({req.clicked_lat:.2f}°N, {req.clicked_lon:.2f}°E)"

    return (
        f"Time series{coord} from {sampled_times[0]} to {sampled_times[-1]}:\n"
        f"Times: {sampled_times}\n"
        f"Values: {sampled_vals}"
    )

def _compare_context(req: SummarizeRequest) -> str:
    if req.view_mode == "compare" and req.time_a and req.time_b:
        return f"Comparing timestamp A ({req.time_a}) vs timestamp B ({req.time_b}). Blue areas = B is lower than A, red areas = B is higher than A."
    if req.view_mode == "anomaly":
        return "Showing anomaly (current value minus long-term mean). Blue = below average, red = above average."
    return ""

def _region_context(req: SummarizeRequest) -> str:
    if req.region_hint:
        return f"The user is currently zoomed into: {req.region_hint}"
    return ""

# ─── Endpoint ─────────────────────────────────────────────────────────────────

@router.post("/summarize")
async def summarize(req: SummarizeRequest):
    """
    Returns a plain-English summary of what the user is currently viewing.
    Powered by Claude via LangChain.
    """
    try:
        result = await chain.ainvoke({
            "variable_description": describe_variable(req.variable),
            "view_mode": req.view_mode,
            "time_context": _time_context(req),
            "stats_context": _stats_context(req),
            "timeseries_context": _timeseries_context(req),
            "compare_context": _compare_context(req),
            "region_context": _region_context(req),
        })
        return {"summary": result.strip()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Summarizer error: {str(e)}")
