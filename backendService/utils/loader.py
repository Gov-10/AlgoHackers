import xarray as xr

def load_dataset():
    ds = xr.open_dataset(
        "era5_india_dummy.nc",
        engine="netcdf4",
        chunks="auto"
    )
    
    print(ds)
    return ds


load_dataset()
