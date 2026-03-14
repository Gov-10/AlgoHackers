from pydantic import BaseModel
class TileSchema(BaseModel):
    variable:str
    time_index:int
    lat_min:float
    lat_max:float
    lon_min:float
    lon_max:float

class TimeSchema(BaseModel):
    variable:str
    lat:float
    lon:float

class CompareSchema(BaseModel):
    variable:str
    time_a:int
    time_b:int
    lat_min:float
    lat_max:float
    lon_min:float
    lon_max:float

class WindSchema(BaseModel):
    time_index:int



