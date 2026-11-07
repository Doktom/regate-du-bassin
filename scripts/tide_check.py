#!/usr/bin/env python3
"""Compares Open-Meteo Marine with the Arcachon-Eyrac tide table (M3 check).
Reference values: maree.info/136, read on 2026-11-07. Needs a local copy, see REFERENCE."""
import datetime as dt
import json
import os
import urllib.request

import numpy as np

# The table is not redistributed here: copy it from maree.info/136 into this file, as a list of
# ["MM-DD", "HH:MM" in UTC+1, height in metres above chart datum].
REFERENCE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache", "tide_reference.json")


def ref_extrema():
    out = []
    with open(REFERENCE, encoding="utf8") as f:
        table = json.load(f)
    for d, h, z in table:
        t = dt.datetime.strptime(f"2026-{d} {h}", "%Y-%m-%d %H:%M").replace(tzinfo=dt.timezone.utc) - dt.timedelta(hours=1)
        out.append((t.timestamp(), z))
    return out


url = ("https://marine-api.open-meteo.com/v1/marine?latitude=44.63&longitude=-1.25&hourly=sea_level_height_msl"
       "&timezone=UTC&start_date=2026-11-07&end_date=2026-11-13")
req = urllib.request.Request(url, headers={"User-Agent": "regate-du-bassin/0.1"})
d = json.load(urllib.request.urlopen(req, timeout=30))
print("model cell", d["latitude"], d["longitude"])
times = np.array([dt.datetime.fromisoformat(s).replace(tzinfo=dt.timezone.utc).timestamp() for s in d["hourly"]["time"]])
h = np.array(d["hourly"]["sea_level_height_msl"], dtype=float)

ext = []
for i in range(1, len(h) - 1):
    if (h[i] - h[i - 1]) * (h[i + 1] - h[i]) <= 0 and h[i] != h[i - 1]:
        a = (h[i - 1] + h[i + 1] - 2 * h[i]) / 2
        b = (h[i + 1] - h[i - 1]) / 2
        x = -b / (2 * a)
        ext.append((times[i] + x * 3600, h[i] + b * x + a * x * x))

pairs = []
for t, z in ref_extrema():
    j = min(range(len(ext)), key=lambda k: abs(ext[k][0] - t))
    if abs(ext[j][0] - t) < 3 * 3600:
        pairs.append((t, z, ext[j][0], ext[j][1]))
p = np.array(pairs)
lag = (p[:, 0] - p[:, 2]) / 60
A = np.vstack([p[:, 3], np.ones(len(p))]).T
k, c = np.linalg.lstsq(A, p[:, 1], rcond=None)[0]
res = p[:, 1] - (k * p[:, 3] + c)
print(f"pairs {len(p)}")
print(f"raw time lag: mean {lag.mean():.0f} min, std {lag.std():.0f}, min {lag.min():.0f}, max {lag.max():.0f}")
print(f"raw height error after removing the mean: rms {np.std((p[:,1]-p[:,1].mean())-(p[:,3]-p[:,3].mean())):.2f} m")
print(f"fit: h_eyrac = {k:.3f} * h_model + {c:.3f}; residual rms {res.std():.2f} m, max {np.abs(res).max():.2f} m")
hw = p[:, 1] > 2.4
print(f"lag at high water {lag[hw].mean():.0f} min, at low water {lag[~hw].mean():.0f} min")
print(f"mean table level {p[:,1].mean():.2f} m")
