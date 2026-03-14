from fastapi import FastAPI
import numpy as np
import pandas as pd
import xarray as xr
from redis import Redis
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from utils.loader import load_dataset
from schemas import TileSchema,TimeSchema, CompareSchema,WindSchema
import os, json
load_dotenv()
redis_client = Redis(
        host = os.getenv("REDIS_URL"), 
        port = int(os.getenv("REDIS_PORT")),
        password=os.getenv("REDIS_PASSWORD"),
        decode_responses=True
        )

ds=load_dataset()
app = FastAPI(title="API docs")

@app.get("/health")
def chek():
    return {"status": "RUNNING"}

@app.get("/variables")
def varget():
    return {"variables": list(ds.data_vars)}

@app.get("/metadata")
def metget():
    time_min=str(ds.time.values[0])
    time_max=str(ds.time.values[-1])
    lat_min=float(ds.latitude.min())
    lat_max=float(ds.latitude.max())
    lon_min=float(ds.longitude.min())
    lon_max=float(ds.longitude.max())
    vari = list(ds.data_vars)
    return {"variables": vari, "time_range":[time_min,time_max], "lat_range": [lat_min, lat_max], "lon_range": [lon_min, lon_max]}

@app.post("/tile")
def viewmap(payload:TileSchema):
    variable,time_index=payload.variable, payload.time_index
    lat_min,lat_max=payload.lat_min, payload.lat_max
    lon_min,lon_max=payload.lon_min, payload.lon_max
    cache_key=f"tile:{payload.variable}:{payload.time_index}:{payload.lat_min}:{payload.lat_max}:{payload.lon_min}:{payload.lon_max}"
    cached = redis_client.get(cache_key)
    if cached:
        return json.loads(cached)
    data=ds[variable].isel(time=time_index).sel(
        latitude=slice(lat_max, lat_min),
        longitude=slice(lon_min, lon_max)
            )
    data=data.coarsen(latitude=2, longitude=2, boundary="trim").mean()
    values=data.compute().values
    resp = {
        "lat" : data.latitude.values.tolist(),
        "lon":data.longitude.values.tolist(),
        "values":values.tolist()
            }
    redis_client.setex(cache_key,3600, json.dumps(resp))
    return resp

@app.post("/timeseries")
def temser(payload:TimeSchema):
    variable=payload.variable
    lat,lon=payload.lat,payload.lon
    point=ds[variable].sel(latitude=lat, longitude=lon, method="nearest")
    times= pd.to_datetime(point.time.values)
    return {
        "time": times.strftime("%Y-%m-%d").tolist(),
        "values" : point.compute().values.tolist()
            }
@app.post("/compare")
def cmp(payload:CompareSchema):
    variable=payload.variable
    time_a, time_b=payload.time_a, payload.time_b
    lat_min,lat_max=payload.lat_min,payload.lat_max
    lon_min,lon_max=payload.lon_min,payload.lon_max
    cache_key=f"compare:{variable}:{time_a}:{time_b}:{lat_min}:{lat_max}:{lon_min}:{lon_max}"
    cached= redis_client.get(cache_key)
    if cached:
        return json.loads(cached)
    data_a=ds[variable].isel(time=time_a).sel(latitude=slice(lat_max,lat_min),longitude=slice(lon_min,lon_max))
    data_a=data_a.coarsen(latitude=2, longitude=2, boundary="trim").mean()
    data_b=ds[variable].isel(time=time_b).sel(latitude=slice(lat_max,lat_min),longitude=slice(lon_min,lon_max))
    data_b=data_b.coarsen(latitude=2, longitude=2, boundary="trim").mean()
    diff= data_b-data_a
    resp = {
        "lat": data_a.latitude.values.tolist(),
        "lon": data_a.longitude.values.tolist(),
        "diff": diff.compute().values.tolist()
            }
    redis_client.setex(cache_key,3600,json.dumps(resp))
    return resp

@app.post("/wind")
def windsp(payload:WindSchema):
    time_index=payload.time_index
    u=ds["u10"].isel(time=time_index)
    v=ds["v10"].isel(time=time_index)
    sp = np.sqrt(u**2 + v**2)
    return {"lat":sp.latitude.values.tolist(), "lon":sp.longitude.values.tolist(), "values": sp.compute().values.tolist()}

@app.get("/anomaly")
def anamol(variable:str, time_index:int):
    baseline=ds[variable].mean(dim="time")
    current=ds[variable].isel(time=time_index)
    anam=current-baseline
    return {"lat":anam.latitude.values.tolist(), "lon":anam.longitude.values.tolist(), "values": anam.compute().values.tolist()}

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)




    










