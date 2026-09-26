-- POI field survey — PostgreSQL + PostGIS schema
-- Run once:  psql -d poi_survey -f schema.sql

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS poi_submissions (
    id              BIGSERIAL PRIMARY KEY,

    -- client-generated, lets a queued record survive retries without duplicating
    client_uuid     UUID        NOT NULL UNIQUE DEFAULT gen_random_uuid(),

    -- survey attributes
    surveyor        TEXT,
    poi_name        TEXT        NOT NULL,
    category        TEXT,
    status          TEXT        NOT NULL,          -- unchanged | renamed | replaced | closed | new
    prior_name      TEXT,                          -- what the 2021 dataset had, if different
    address         TEXT,
    floor           TEXT,
    phone           TEXT,
    notes           TEXT,

    -- anything the form grows later lands here instead of a migration
    attrs           JSONB       NOT NULL DEFAULT '{}'::jsonb,

    -- capture metadata
    photo_path      TEXT,
    gps_accuracy_m  REAL,
    captured_at     TIMESTAMPTZ,                   -- when the device recorded it
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- spatial
    geom            geometry(Point, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS poi_submissions_geom_idx
    ON poi_submissions USING GIST (geom);

CREATE INDEX IF NOT EXISTS poi_submissions_received_idx
    ON poi_submissions (received_at DESC);

CREATE INDEX IF NOT EXISTS poi_submissions_attrs_idx
    ON poi_submissions USING GIN (attrs);

-- Optional: the 2021 baseline you're updating against.
-- Load your existing dataset here and the app can show nearby prior POIs.
CREATE TABLE IF NOT EXISTS poi_baseline_2021 (
    id          BIGSERIAL PRIMARY KEY,
    source_id   TEXT,
    name        TEXT,
    category    TEXT,
    address     TEXT,
    geom        geometry(Point, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS poi_baseline_2021_geom_idx
    ON poi_baseline_2021 USING GIST (geom);
