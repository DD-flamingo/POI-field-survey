# POI Field Survey

A web-based Point of Interest (POI) field survey application for updating
2021 POI records with 2025 field observations.

The application provides a paged field-survey form with GPS location and
photo capture, stores survey submissions in PostgreSQL/PostGIS, and provides
a Leaflet-based map for viewing collected POIs.

## Architecture

```text
Browser / Mobile
       │
       │ GPS + Form + Photo
       ▼
HTML / CSS / JavaScript
       │
       │ multipart POST
       ▼
Flask API
       │
       │ psycopg2
       ▼
PostgreSQL + PostGIS
       │
       │ GeoJSON
       ▼
Leaflet Map
