"""
POI field survey — Flask API

Frontend posts multipart/form-data:
    record : JSON string with the survey answers + lat/lon
    photo  : optional image file

Records are keyed by a client-generated UUID so a retried upload from the
offline queue updates rather than duplicates.

Run:
    export DATABASE_URL="postgresql://user:pass@localhost:5432/poi_survey"
    python app.py
"""

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
import psycopg2.extras
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from psycopg2.pool import ThreadedConnectionPool
from werkzeug.utils import secure_filename



BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", BASE_DIR / "uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

DB_HOST = os.environ.get("DB_HOST", "localhost")
DB_PORT = int(os.environ.get("DB_PORT", 5432))
DB_NAME = os.environ.get("DB_NAME", "field_survey")
DB_USER = os.environ.get("DB_USER", "postgres")
DB_PASSWORD = os.environ.get("DB_PASSWORD")

if not DB_PASSWORD:
    raise RuntimeError("DB_PASSWORD environment variable is not set")

MAX_UPLOAD_MB = 12
ALLOWED_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic"}

app = Flask(__name__, static_folder=str(BASE_DIR / "static"), static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024
CORS(app)

pool = ThreadedConnectionPool(
    1,
    10,
    host=DB_HOST,
    port=DB_PORT,
    database=DB_NAME,
    user=DB_USER,
    password=DB_PASSWORD
)


class Db:
    """Context manager that hands back a pooled connection and commits or rolls back."""

    def __enter__(self):
        self.conn = pool.getconn()
        self.cur = self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        return self.cur

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self.conn.commit()
        else:
            self.conn.rollback()
        self.cur.close()
        pool.putconn(self.conn)


# --- fields that get their own column; everything else falls into attrs ------
COLUMN_FIELDS = (
    "surveyor", "poi_name", "category", "status", "prior_name",
    "address", "floor", "phone", "notes",
)


def parse_record(raw):
    """Validate the posted JSON and split it into columns + attrs."""
    if not isinstance(raw, dict):
        raise ValueError("record must be a JSON object")

    try:
        lat = float(raw["lat"])
        lon = float(raw["lon"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("record needs numeric lat and lon")

    if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        raise ValueError("lat/lon out of range")

    if not str(raw.get("poi_name", "")).strip():
        raise ValueError("poi_name is required")
    if not str(raw.get("status", "")).strip():
        raise ValueError("status is required")

    client_uuid = raw.get("client_uuid") or str(uuid.uuid4())
    try:
        uuid.UUID(client_uuid)
    except ValueError:
        raise ValueError("client_uuid must be a UUID")

    cols = {f: (str(raw[f]).strip() or None) if raw.get(f) is not None else None
            for f in COLUMN_FIELDS}

    reserved = set(COLUMN_FIELDS) | {
        "lat", "lon", "client_uuid", "gps_accuracy_m", "captured_at"
    }
    attrs = {k: v for k, v in raw.items() if k not in reserved}

    accuracy = raw.get("gps_accuracy_m")
    try:
        accuracy = float(accuracy) if accuracy is not None else None
    except (TypeError, ValueError):
        accuracy = None

    captured_at = raw.get("captured_at")
    if captured_at:
        try:
            captured_at = datetime.fromisoformat(str(captured_at).replace("Z", "+00:00"))
        except ValueError:
            captured_at = None
    else:
        captured_at = None

    return {
        "client_uuid": client_uuid,
        "lat": lat,
        "lon": lon,
        "cols": cols,
        "attrs": attrs,
        "gps_accuracy_m": accuracy,
        "captured_at": captured_at or datetime.now(timezone.utc),
    }


def save_photo(file_storage, client_uuid):
    if not file_storage or not file_storage.filename:
        return None
    ext = Path(secure_filename(file_storage.filename)).suffix.lower()
    if ext not in ALLOWED_IMAGE_EXT:
        raise ValueError(f"unsupported image type: {ext or 'none'}")
    name = f"{client_uuid}{ext}"
    file_storage.save(UPLOAD_DIR / name)
    return name


# --- pages ------------------------------------------------------------------

@app.get("/")
def form_page():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/map")
def map_page():
    return send_from_directory(app.static_folder, "map.html")


@app.get("/photos/<path:filename>")
def photo(filename):
    return send_from_directory(UPLOAD_DIR, filename)


# --- API --------------------------------------------------------------------

@app.get("/api/health")
def health():
    try:
        with Db() as cur:
            cur.execute("SELECT postgis_version() AS v")
            v = cur.fetchone()["v"]
        return jsonify(ok=True, postgis=v)
    except Exception as exc:
        return jsonify(ok=False, error=str(exc)), 503


@app.post("/api/submissions")
def create_submission():
    try:
        raw = request.form.get("record")
        payload = json.loads(raw) if raw else request.get_json(silent=True)
        rec = parse_record(payload)
        photo_name = save_photo(request.files.get("photo"), rec["client_uuid"])
    except (ValueError, json.JSONDecodeError) as exc:
        return jsonify(ok=False, error=str(exc)), 400

    c = rec["cols"]
    with Db() as cur:
        cur.execute(
            """
            INSERT INTO poi_submissions (
                client_uuid, surveyor, poi_name, category, status, prior_name,
                address, floor, phone, notes, attrs, photo_path,
                gps_accuracy_m, captured_at, geom
            ) VALUES (
                %(client_uuid)s, %(surveyor)s, %(poi_name)s, %(category)s,
                %(status)s, %(prior_name)s, %(address)s, %(floor)s, %(phone)s,
                %(notes)s, %(attrs)s, %(photo_path)s, %(accuracy)s, %(captured_at)s,
                ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326)
            )
            ON CONFLICT (client_uuid) DO UPDATE SET
                poi_name = EXCLUDED.poi_name,
                category = EXCLUDED.category,
                status   = EXCLUDED.status,
                notes    = EXCLUDED.notes,
                attrs    = EXCLUDED.attrs,
                photo_path = COALESCE(EXCLUDED.photo_path, poi_submissions.photo_path),
                geom     = EXCLUDED.geom
            RETURNING id, client_uuid
            """,
            {
                "client_uuid": rec["client_uuid"],
                **c,
                "attrs": json.dumps(rec["attrs"]),
                "photo_path": photo_name,
                "accuracy": rec["gps_accuracy_m"],
                "captured_at": rec["captured_at"],
                "lat": rec["lat"],
                "lon": rec["lon"],
            },
        )
        row = cur.fetchone()

    return jsonify(ok=True, id=row["id"], client_uuid=str(row["client_uuid"])), 201


@app.get("/api/submissions")
def list_submissions():
    """GeoJSON FeatureCollection. Optional bbox=minlon,minlat,maxlon,maxlat"""
    bbox = request.args.get("bbox")
    limit = min(int(request.args.get("limit", 2000)), 5000)

    where, params = "TRUE", {"limit": limit}
    if bbox:
        try:
            x1, y1, x2, y2 = (float(v) for v in bbox.split(","))
        except ValueError:
            return jsonify(ok=False, error="bbox must be 4 numbers"), 400
        where = "geom && ST_MakeEnvelope(%(x1)s, %(y1)s, %(x2)s, %(y2)s, 4326)"
        params.update(x1=x1, y1=y1, x2=x2, y2=y2)

    with Db() as cur:
        cur.execute(
            f"""
            SELECT json_build_object(
              'type', 'FeatureCollection',
              'features', COALESCE(json_agg(f), '[]'::json)
            ) AS fc
            FROM (
              SELECT json_build_object(
                'type', 'Feature',
                'geometry', ST_AsGeoJSON(geom)::json,
                'properties', json_build_object(
                    'id', id, 'poi_name', poi_name, 'category', category,
                    'status', status, 'prior_name', prior_name, 'address', address,
                    'floor', floor, 'surveyor', surveyor, 'notes', notes,
                    'photo_url', CASE WHEN photo_path IS NULL THEN NULL
                                      ELSE '/photos/' || photo_path END,
                    'gps_accuracy_m', gps_accuracy_m,
                    'captured_at', captured_at,
                    'attrs', attrs
                )
              ) AS f
              FROM poi_submissions
              WHERE {where}
              ORDER BY received_at DESC
              LIMIT %(limit)s
            ) sub
            """,
            params,
        )
        return jsonify(cur.fetchone()["fc"])


@app.get("/api/nearby")
def nearby():
    """Prior-year POIs within `radius` metres — lets the surveyor confirm a match."""
    try:
        lat = float(request.args["lat"])
        lon = float(request.args["lon"])
    except (KeyError, ValueError):
        return jsonify(ok=False, error="lat and lon required"), 400
    radius = min(float(request.args.get("radius", 60)), 500)

    with Db() as cur:
        cur.execute(
            """
            SELECT id, name, category, address,
                   ROUND(ST_Distance(geom::geography,
                         ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326)::geography)::numeric, 1)
                   AS distance_m
            FROM poi_baseline_2021
            WHERE ST_DWithin(geom::geography,
                             ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326)::geography,
                             %(radius)s)
            ORDER BY distance_m
            LIMIT 10
            """,
            {"lat": lat, "lon": lon, "radius": radius},
        )
        return jsonify([dict(r, distance_m=float(r["distance_m"])) for r in cur.fetchall()])


@app.get("/api/stats")
def stats():
    with Db() as cur:
        cur.execute(
            """
            SELECT count(*) AS total,
                   count(*) FILTER (WHERE received_at::date = current_date) AS today,
                   count(*) FILTER (WHERE photo_path IS NOT NULL) AS with_photo
            FROM poi_submissions
            """
        )
        return jsonify(cur.fetchone())


@app.errorhandler(413)
def too_large(_):
    return jsonify(ok=False, error=f"photo larger than {MAX_UPLOAD_MB} MB"), 413


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
