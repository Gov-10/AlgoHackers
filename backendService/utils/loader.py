import xarray as xr

def load_dataset():
    ds = xr.open_dataset(
        "era5_india.nc",
        engine="netcdf4",
        chunks="auto"
    )
    
    print(ds)
    return ds


load_dataset()
