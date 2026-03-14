from fastapi import FastAPI
import numpy as np
import pandas as pd
import xarray as xr
from redis import Redis
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from utils.loader import load_dataset
from schemas import TileSchema, TimeSchema, CompareSchema, WindSchema
import os, json

load_dotenv()
redis_client = Redis(
    host=os.getenv("REDIS_URL"),
    port=int(os.getenv("REDIS_PORT")),
    password=os.getenv("REDIS_PASSWORD"),
    decode_responses=True
)


ds = load_dataset()
ds["time"] = pd.to_datetime(ds["time"].values)
baseline_cache = {v: ds[v].mean(dim="time") for v in ds.data_vars}

app = FastAPI(title="Climate API")

def get_time_index(year, month, day, hour):
    target = pd.Timestamp(year=year, month=month, day=day, hour=hour)
    idx = np.argmin(np.abs(ds.time.values - target))
    return int(idx)


def slice_tile(variable, time_idx, lat_min, lat_max, lon_min, lon_max):
    data = ds[variable].isel(time=time_idx).sel(
        latitude=slice(lat_max, lat_min),
        longitude=slice(lon_min, lon_max)
    )
    data = data.coarsen(latitude=2, longitude=2, boundary="trim").mean()
    return data

@app.get("/health")
def check():
    return {"status": "RUNNING"}

@app.get("/variables")
def variables():
    return {"variables": list(ds.data_vars)}

@app.get("/metadata")
def metadata():
    lat = ds.latitude.values
    lon = ds.longitude.values
    return {
        "variables": list(ds.data_vars),
        "years": list(pd.to_datetime(ds.time.values).year.unique()),
        "lat_range": [float(lat.min()), float(lat.max())],
        "lon_range": [float(lon.min()), float(lon.max())]
    }

@app.post("/tile")
def tile(payload: TileSchema):
    variable = payload.variable
    if variable not in ds.data_vars:
        return {"error": "invalid variable"}
    time_idx = get_time_index(
        payload.year,
        payload.month,
        payload.day,
        payload.hour
    )
    cache_key = f"tile:{variable}:{time_idx}:{payload.lat_min}:{payload.lat_max}:{payload.lon_min}:{payload.lon_max}"
    cached = redis_client.get(cache_key)
    if cached:
        return json.loads(cached)
    data = slice_tile(
        variable,
        time_idx,
        payload.lat_min,
        payload.lat_max,
        payload.lon_min,
        payload.lon_max
    )
    resp = {
        "lat": data.latitude.values.tolist(),
        "lon": data.longitude.values.tolist(),
        "values": data.compute().values.tolist()
    }
    redis_client.setex(cache_key, 3600, json.dumps(resp))
    return resp

@app.post("/timeseries")
def timeseries(payload: TimeSchema):
    variable = payload.variable
    point = ds[variable].sel(
        latitude=payload.lat,
        longitude=payload.lon,
        method="nearest"
    )
    times = pd.to_datetime(point.time.values)
    return {
        "time": times.strftime("%Y-%m-%d %H:%M").tolist(),
        "values": point.compute().values.tolist()
    }

@app.post("/compare")
def compare(payload: CompareSchema):
    variable = payload.variable
    time_a = get_time_index(payload.year_a, payload.month_a, payload.day_a, payload.hour_a)
    time_b = get_time_index(payload.year_b, payload.month_b, payload.day_b, payload.hour_b)
    cache_key = f"compare:{variable}:{time_a}:{time_b}:{payload.lat_min}:{payload.lat_max}:{payload.lon_min}:{payload.lon_max}"
    cached = redis_client.get(cache_key)
    if cached:
        return json.loads(cached)
    data_a = slice_tile(variable, time_a, payload.lat_min, payload.lat_max, payload.lon_min, payload.lon_max)
    data_b = slice_tile(variable, time_b, payload.lat_min, payload.lat_max, payload.lon_min, payload.lon_max)
    diff = data_b - data_a
    resp = {
        "lat": data_a.latitude.values.tolist(),
        "lon": data_a.longitude.values.tolist(),
        "diff": diff.compute().values.tolist()
    }
    redis_client.setex(cache_key, 3600, json.dumps(resp))
    return resp

@app.post("/wind")
def wind(payload: WindSchema):
    time_idx = get_time_index(payload.year, payload.month, payload.day, payload.hour)
    u = ds["u10"].isel(time=time_idx)
    v = ds["v10"].isel(time=time_idx)
    speed = np.sqrt(u**2 + v**2)
    return {
        "lat": speed.latitude.values.tolist(),
        "lon": speed.longitude.values.tolist(),
        "values": speed.compute().values.tolist()
    }

@app.get("/anomaly")
def anomaly(variable: str, year: int, month: int, day: int, hour: int):
    time_idx = get_time_index(year, month, day, hour)
    baseline = baseline_cache[variable]
    current = ds[variable].isel(time=time_idx)
    anom = current - baseline
    return {
        "lat": anom.latitude.values.tolist(),
        "lon": anom.longitude.values.tolist(),
        "values": anom.compute().values.tolist()
    }

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)








