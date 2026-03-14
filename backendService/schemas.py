from pydantic import BaseModel


class TileSchema(BaseModel):
    variable: str
    year: int
    month: int
    day: int
    hour: int
    lat_min: float
    lat_max: float
    lon_min: float
    lon_max: float


class TimeSchema(BaseModel):
    variable: str
    lat: float
    lon: float


class CompareSchema(BaseModel):
    variable: str
    year_a: int
    month_a: int
    day_a: int
    hour_a: int
    year_b: int
    month_b: int
    day_b: int
    hour_b: int
    lat_min: float
    lat_max: float
    lon_min: float
    lon_max: float


class WindSchema(BaseModel):
    year: int
    month: int
    day: int
    hour: int
