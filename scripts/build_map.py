#!/usr/bin/env python3
"""Prepares the map data committed in /data.

Sources (network, cached in scripts/.cache):
  - OpenStreetMap coastline through Overpass (ODbL)
  - EMODnet Bathymetry DTM (CC BY 4.0), about 115 m per cell, heights above LAT

Outputs:
  - data/coastline.geojson : land polygons, simplified
  - data/bathy.json        : int8 raster in decimetres relative to mean sea level

Requires: numpy, scipy, shapely, pillow.
"""
import base64
import json
import os
import urllib.parse
import urllib.request

import numpy as np
from PIL import Image
from scipy import ndimage
from shapely import contains_xy, make_valid
from shapely.geometry import LineString, MultiPolygon, Polygon, box, mapping
from shapely.ops import linemerge, unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "scripts", ".cache")
UA = {"User-Agent": "regate-du-bassin-map-build/0.1"}

WEST, SOUTH, EAST, NORTH = -1.32, 44.55, -0.98, 44.80
RES = 0.0010416667
# Mean of high and low waters at Arcachon-Eyrac above chart datum (LAT), in metres.
MSL_ABOVE_LAT = 2.45
SIMPLIFY_DEG = 0.00012
MAX_DM = 127


def cached(name, fetch):
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        os.makedirs(CACHE, exist_ok=True)
        with open(path, "wb") as f:
            f.write(fetch())
    return path


def fetch_osm():
    q = '[out:json][timeout:90];way["natural"="coastline"](44.50,-1.35,44.82,-0.95);out geom;'
    req = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        data=urllib.parse.urlencode({"data": q}).encode(),
        headers=UA,
    )
    return urllib.request.urlopen(req, timeout=120).read()


def fetch_emodnet():
    params = {
        "service": "WCS", "version": "1.0.0", "request": "GetCoverage",
        "coverage": "emodnet:mean", "crs": "EPSG:4326",
        "bbox": f"{WEST},{SOUTH},{EAST},{NORTH}",
        "format": "image/tiff", "resx": RES, "resy": RES,
    }
    url = "https://ows.emodnet-bathymetry.eu/wcs?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=120).read()


def build_land():
    with open(cached("osm.json", fetch_osm), encoding="utf8") as f:
        ways = json.load(f)["elements"]
    lines = [LineString([(n["lon"], n["lat"]) for n in w["geometry"]]) for w in ways]
    merged = linemerge(lines)
    parts = list(merged.geoms) if hasattr(merged, "geoms") else [merged]
    polys = []
    for line in parts:
        c = list(line.coords)
        if line.is_ring:
            polys.append(Polygon(c))
        else:
            # The mainland chain runs with land on its left: close it to the east.
            polys.append(Polygon(c + [(-0.90, c[-1][1]), (-0.90, c[0][1])]))
    land = unary_union([make_valid(p) for p in polys]).intersection(box(WEST, SOUTH, EAST, NORTH))
    return land


def main():
    land = build_land()
    simple = land.simplify(SIMPLIFY_DEG, preserve_topology=True)
    geoms = list(simple.geoms) if isinstance(simple, MultiPolygon) else [simple]
    geoms = [g for g in geoms if isinstance(g, Polygon) and g.area > 2e-7]
    features = [
        {"type": "Feature", "properties": {}, "geometry": json.loads(json.dumps(mapping(g)))}
        for g in geoms
    ]
    for feat in features:
        feat["geometry"]["coordinates"] = [
            [[round(x, 5), round(y, 5)] for x, y in ring] for ring in feat["geometry"]["coordinates"]
        ]
    with open(os.path.join(ROOT, "data", "coastline.geojson"), "w", encoding="utf8") as f:
        json.dump({
            "type": "FeatureCollection",
            "attribution": "© OpenStreetMap contributors (ODbL)",
            "features": features,
        }, f, separators=(",", ":"))

    a = np.array(Image.open(cached("emodnet.tif", fetch_emodnet))).astype(np.float64)
    ny, nx = a.shape
    lons = WEST + (np.arange(nx) + 0.5) * RES
    lats = NORTH - (np.arange(ny) + 0.5) * RES
    xx, yy = np.meshgrid(lons, lats)
    is_land = contains_xy(land, xx, yy)

    h = a - MSL_ABOVE_LAT
    # Removes the salt-and-pepper survey noise on the flats. The channels are wide
    # enough to survive this; a test checks every course is still sailable.
    smooth = ndimage.median_filter(h, size=3)
    flats = h > -1.5
    h[flats] = smooth[flats]
    # Cells OSM calls water but the DTM calls land become high, always dry sand.
    h = np.minimum(h, 2.5)
    h[is_land] = MAX_DM / 10
    dm = np.clip(np.round(h * 10), -MAX_DM, MAX_DM).astype(np.int8)
    # Row 0 is the southern row, so that row index grows with latitude.
    dm = dm[::-1]
    with open(os.path.join(ROOT, "data", "bathy.json"), "w", encoding="utf8") as f:
        json.dump({
            "attribution": "EMODnet Bathymetry (CC BY 4.0)",
            "lat0": round(float(lats[-1]), 7), "lon0": round(float(lons[0]), 7),
            "dLat": RES, "dLon": RES, "nx": nx, "ny": ny,
            "unit": "decimetres relative to mean sea level; +12.7 m means land",
            "data": base64.b64encode(dm.tobytes()).decode(),
        }, f, separators=(",", ":"))
    points = sum(len(r) for g in features for r in g["geometry"]["coordinates"])
    print(f"coastline: {len(features)} polygons, {points} points; bathy: {nx}x{ny}")


if __name__ == "__main__":
    main()
