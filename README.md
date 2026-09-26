# POI field survey

A Kobo/Enketo-style collection app for the 2021 → 2025 POI update: paged form,
GPS + photo capture, a browser-side queue that survives going offline, and a
Leaflet view of what's been covered.

```
static/index.html + form.js + style.css     ← field UI, IndexedDB queue
                    │  multipart POST
                    ▼
app.py (Flask)                              ← validation, photo storage
                    │  psycopg2
                    ▼
PostgreSQL + PostGIS                        ← attributes + POINT(4326)
                    │  GeoJSON
                    ▼
static/map.html (Leaflet)
```

## Setup

```bash
createdb poi_survey
psql -d poi_survey -f schema.sql

python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export DATABASE_URL="postgresql://user:pass@localhost:5432/poi_survey"
python app.py
```

Form at `http://localhost:5000/`, map at `/map`, sanity check at `/api/health`.

### Testing on a phone

`getUserMedia` and `geolocation` need a secure context, so a phone pointed at
`http://192.168.x.x:5000` will refuse to give you a GPS fix. Either tunnel it
(`ngrok http 5000`) or put a TLS-terminating reverse proxy in front.

## Changing the questions

Everything lives in the `FORM` array at the top of `static/form.js`. A page is
`{ title, hint, fields: [...] }`; supported field types are `text`, `tel`,
`number`, `textarea`, `select`, `radio`, `checkbox`, `geopoint`, `photo`.

Useful per-field keys:

| key | does |
| --- | --- |
| `required` | blocks Next until answered |
| `requiredUnless: { status: "closed" }` | drops the requirement conditionally |
| `showIf: { status: ["renamed", "replaced"] }` | conditional display |
| `remember: true` | persists across records (surveyor, grid ID) |
| `hint` | grey helper line under the label |

A field whose `name` matches a column in `poi_submissions` goes into that
column. Anything else lands in the `attrs` JSONB, so adding a question needs no
migration — `grid_id`, `access` and `category_other` already work that way.

## How the offline queue behaves

Records go into IndexedDB *before* any network attempt, keyed by a
client-generated UUID. Upload runs on submit, on the `online` event, and every
five minutes. The server upserts on `client_uuid`, so a retry after a timeout
updates the row instead of creating a twin. A 400 (malformed record) parks the
item as a draft rather than retrying forever; a connection failure leaves it
queued.

Photos are downscaled to a 1600 px long edge at JPEG q0.8 in the browser, which
keeps a typical storefront shot around 200–400 KB — small enough to push over a
weak connection and still readable for OCR.

## API

| route | |
| --- | --- |
| `POST /api/submissions` | multipart: `record` (JSON) + optional `photo` |
| `GET /api/submissions` | GeoJSON FeatureCollection, optional `bbox`, `limit` |
| `GET /api/nearby?lat=&lon=&radius=` | matching 2021 baseline POIs within N metres |
| `GET /api/stats` | totals, today's count, count with photos |
| `GET /api/health` | DB + PostGIS check |

## Where this plugs into the rest of the workflow

- `poi_baseline_2021` is empty until you load the old dataset. Once it's
  populated, `/api/nearby` returns candidate matches so a surveyor can confirm
  which prior record they're updating instead of typing `prior_name` blind.
- Uploaded photos land in `uploads/` named by `client_uuid`, which is the handle
  to hand to the OCR step; write the extracted name back into
  `attrs->>'ocr_name'` and compare against `poi_name`.
- Taxonomy matching: the `category` list in `form.js` is a placeholder. Generate
  those option pairs from the taxonomy Excel file so the values written to the
  DB are already canonical codes.

## Before it goes to real surveyors

- No auth yet — anyone who can reach the host can post. Add a token per surveyor
  and check it in a `before_request`.
- `uploads/` is local disk. Move to S3 or equivalent before multiple surveyors
  run in parallel.
- Run behind gunicorn (`gunicorn -w 4 app:app`), not the dev server.
- Add a service worker if you want the page itself to open while offline; today
  the queue survives offline but the first load needs a connection.
