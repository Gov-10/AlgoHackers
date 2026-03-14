const API = "http://localhost:8000";

export async function getVariables() {
  const res = await fetch(`${API}/variables`);
  return res.json();
}

export async function getTile(payload:any) {
  const res = await fetch(`${API}/tile`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload)
  });
  return res.json();
}

export async function getTimeSeries(payload:any) {
  const res = await fetch(`${API}/timeseries`, {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });

  return res.json();
}
