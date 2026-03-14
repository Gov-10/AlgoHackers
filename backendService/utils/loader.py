import os
from dotenv import load_dotenv
load_dotenv()
S3_BUCKET=os.getenv("S3_BUCKET")
DATASET_KEY=os.getenv("DATASET_KEY")
USE_ZARR=True
def load_dataset():
    path=f"s3://{S3_BUCKET}/{DATASET_KEY}"
    ds=xr.open_zarr(path, consolidated=False, chunks="auto")
    return ds
    
