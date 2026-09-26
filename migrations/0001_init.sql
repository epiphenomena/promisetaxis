-- Copán Ruinas tuktuk dispatch — initial schema.

-- Areas of town. Routing resolves to this granularity and no finer: streets are
-- narrow, windy and randomly blocked, so real travel time swamps any precision
-- beyond "which part of town".
CREATE TABLE zones (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- Rough centroid, used only to snap an incoming GPS pin to a zone.
  lat        REAL NOT NULL,
  lng        REAL NOT NULL
);

-- The gazetteer. Addresses here are things like "the blue house on the hill",
-- so landmarks are the addressing system.
CREATE TABLE landmarks (
  id         TEXT PRIMARY KEY,
  zone_id    TEXT NOT NULL REFERENCES zones(id),
  name       TEXT NOT NULL,
  -- Lowercase, comma-separated alternate spellings for free-text fallback.
  aliases    TEXT NOT NULL DEFAULT '',
  lat        REAL,
  lng        REAL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_landmarks_zone ON landmarks(zone_id, active);

-- Ordered pairs. Seeded by hand, then refined from observed trip durations.
CREATE TABLE zone_times (
  from_zone  TEXT NOT NULL REFERENCES zones(id),
  to_zone    TEXT NOT NULL REFERENCES zones(id),
  minutes    REAL NOT NULL,
  -- How many completed trips have informed this estimate. 0 = hand-seeded.
  samples    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (from_zone, to_zone)
);

CREATE TABLE drivers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  phone              TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  tuktuk_no          TEXT,
  -- off | available | assigned | on_trip | break
  status             TEXT NOT NULL DEFAULT 'off',
  -- Where we believe the driver is right now (inferred from trip events).
  zone_id            TEXT REFERENCES zones(id),
  -- Where they will be when their current trip ends. Equals zone_id when idle.
  projected_zone_id  TEXT REFERENCES zones(id),
  -- Epoch ms when they become free; <= now means free already.
  available_at       INTEGER NOT NULL DEFAULT 0,
  -- Epoch ms they last became idle, used for fairness tie-breaks.
  idle_since         INTEGER NOT NULL DEFAULT 0,
  active             INTEGER NOT NULL DEFAULT 1,
  updated_at         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_drivers_status ON drivers(status, active);

CREATE TABLE trips (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'hail' = requested through the bot, 'bandera' = flagged down in the street.
  source            TEXT NOT NULL DEFAULT 'hail',
  customer_phone    TEXT,
  pickup_lat        REAL,
  pickup_lng        REAL,
  pickup_zone_id    TEXT REFERENCES zones(id),
  pickup_label      TEXT,
  dest_zone_id      TEXT REFERENCES zones(id),
  dest_landmark_id  TEXT REFERENCES landmarks(id),
  dest_label        TEXT,
  driver_id         INTEGER REFERENCES drivers(id),
  -- pending | assigned | on_trip | done | canceled
  state             TEXT NOT NULL DEFAULT 'pending',
  quoted_wait_min   REAL,
  requested_at      INTEGER NOT NULL,
  assigned_at       INTEGER,
  picked_up_at      INTEGER,
  done_at           INTEGER,
  canceled_reason   TEXT
);
CREATE INDEX idx_trips_state ON trips(state, requested_at);
CREATE INDEX idx_trips_driver ON trips(driver_id, requested_at);

-- Conversation state for both roles. One row per phone number.
CREATE TABLE sessions (
  phone        TEXT PRIMARY KEY,
  role         TEXT NOT NULL,              -- 'customer' | 'driver'
  state        TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  -- Epoch ms when the free 24h service window closes. Editable by hand so the
  -- lapsed-window/template path can be tested without waiting a day.
  window_expires_at INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT 0
);

-- Break / availability events, kept separate from trips for reporting.
CREATE TABLE status_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id  INTEGER NOT NULL REFERENCES drivers(id),
  status     TEXT NOT NULL,
  zone_id    TEXT REFERENCES zones(id),
  at         INTEGER NOT NULL
);
CREATE INDEX idx_status_events_driver ON status_events(driver_id, at);

-- Raw audit log of every inbound and outbound message. Settles disputes
-- ("the bot never sent me that trip") and feeds zone_times refinement.
CREATE TABLE events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  direction    TEXT NOT NULL,             -- 'in' | 'out'
  phone        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  -- Provider message id for inbound, NULL for outbound. Meta retries webhook
  -- deliveries, and a replayed "Listo" would close two trips — so inbound
  -- handling is gated on winning the insert against this unique index.
  message_id   TEXT,
  at           INTEGER NOT NULL
);
CREATE INDEX idx_events_phone ON events(phone, at);
CREATE UNIQUE INDEX idx_events_message_id ON events(message_id) WHERE message_id IS NOT NULL;

-- Outbound messages captured by the fake transport in DEV_MODE. The
-- fake-WhatsApp harness polls this table; production never writes to it.
CREATE TABLE dev_outbox (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  phone     TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  at        INTEGER NOT NULL
);
CREATE INDEX idx_dev_outbox_phone ON dev_outbox(phone, id);
