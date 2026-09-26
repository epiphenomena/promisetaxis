/** Zones, landmarks, and the travel-time matrix. */

export type Zone = { id: string; name: string; lat: number; lng: number; sort_order: number };
export type Landmark = {
  id: string;
  zone_id: string;
  name: string;
  aliases: string;
  lat: number | null;
  lng: number | null;
};

export async function listZones(db: D1Database): Promise<Zone[]> {
  const { results } = await db
    .prepare("SELECT id, name, lat, lng, sort_order FROM zones ORDER BY sort_order")
    .all<Zone>();
  return results;
}

export async function listLandmarks(db: D1Database, zoneId: string): Promise<Landmark[]> {
  const { results } = await db
    .prepare(
      `SELECT id, zone_id, name, aliases, lat, lng FROM landmarks
       WHERE zone_id = ? AND active = 1 ORDER BY sort_order`,
    )
    .bind(zoneId)
    .all<Landmark>();
  return results;
}

export async function getLandmark(db: D1Database, id: string): Promise<Landmark | null> {
  return db
    .prepare("SELECT id, zone_id, name, aliases, lat, lng FROM landmarks WHERE id = ?")
    .bind(id)
    .first<Landmark>();
}

export async function getZone(db: D1Database, id: string): Promise<Zone | null> {
  return db
    .prepare("SELECT id, name, lat, lng, sort_order FROM zones WHERE id = ?")
    .bind(id)
    .first<Zone>();
}

/**
 * Equirectangular approximation — accurate well past what a 2 km town needs,
 * and far cheaper than haversine.
 */
export function distanceKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const toRad = Math.PI / 180;
  const x = (b.lng - a.lng) * toRad * Math.cos(((a.lat + b.lat) / 2) * toRad);
  const y = (b.lat - a.lat) * toRad;
  return Math.sqrt(x * x + y * y) * R;
}

/**
 * Snap a GPS pin to its nearest zone centroid.
 *
 * Deliberately crude: the pin's exact coordinates are preserved on the trip and
 * forwarded to the driver, so all this has to get right is which part of town
 * to score against.
 */
export async function zoneForPoint(
  db: D1Database,
  point: { lat: number; lng: number },
): Promise<Zone | null> {
  const zones = await listZones(db);
  let best: Zone | null = null;
  let bestDist = Infinity;
  for (const z of zones) {
    const d = distanceKm(point, z);
    if (d < bestDist) {
      bestDist = d;
      best = z;
    }
  }
  return best;
}

/** Travel time between zones. Falls back to a pessimistic default if unseeded. */
export async function travelMinutes(
  db: D1Database,
  from: string | null,
  to: string | null,
): Promise<number> {
  if (!from || !to) return 10;
  const row = await db
    .prepare("SELECT minutes FROM zone_times WHERE from_zone = ? AND to_zone = ?")
    .bind(from, to)
    .first<{ minutes: number }>();
  return row?.minutes ?? 10;
}

/**
 * Free-text fallback for the "Otro lugar…" row and for customers who type
 * instead of tapping. Matches against name and the alias list.
 */
export async function matchLandmarkText(
  db: D1Database,
  text: string,
): Promise<Landmark[]> {
  const needle = normalize(text);
  if (needle.length < 3) return [];

  const { results } = await db
    .prepare("SELECT id, zone_id, name, aliases, lat, lng FROM landmarks WHERE active = 1")
    .all<Landmark>();

  const scored = results
    .map((lm) => ({ lm, score: scoreMatch(needle, lm) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 3).map((s) => s.lm);
}

function scoreMatch(needle: string, lm: Landmark): number {
  const candidates = [normalize(lm.name), ...lm.aliases.split(",").map(normalize)].filter(Boolean);
  let best = 0;
  for (const c of candidates) {
    if (c === needle) best = Math.max(best, 100);
    else if (c.includes(needle) || needle.includes(c)) best = Math.max(best, 60);
    else if (sharesWord(c, needle)) best = Math.max(best, 30);
  }
  return best;
}

function sharesWord(a: string, b: string): boolean {
  const aw = new Set(a.split(" ").filter((w) => w.length > 2));
  return b.split(" ").some((w) => w.length > 2 && aw.has(w));
}

/** Lowercase, strip accents and punctuation — "Doña" and "dona" must match. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
