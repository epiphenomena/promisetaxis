/**
 * The town as data: one projection, six zone polygons, a road graph, and the
 * gateways that stand in for everywhere too far away to draw.
 *
 * Nothing here decides how long a trip takes. The graph supplies a route's
 * *shape* and the domain's zone matrix supplies its *duration* (R3) — so this
 * file may be as stylized as it likes without the demo ever showing a drive that
 * disagrees with the quote the customer read.
 *
 * Two honesty rules hold everything together:
 *
 *   1. Inside the frame, position is a real projection of the seeded
 *      coordinates. Nothing is nudged to look nicer.
 *   2. Every drawn zone polygon lies entirely inside that zone's Voronoi cell.
 *      `zoneForPoint` (places.ts) snaps a pin to the nearest zone centroid, so
 *      the Voronoi cell of a centroid *is* the set of pins the domain will call
 *      that zone. Clipping each hand-drawn blob to its own cell means a pin
 *      drawn inside "Centro" can never be scored as "Barrio abajo" — the one
 *      way a pretty map could quietly contradict the dispatcher.
 *
 * Both are asserted at startup by `loadTown`, against the database rather than
 * against a copy of the seed, so a future gazetteer edit cannot silently break
 * them.
 */

import { listZones, travelMinutes } from "../../src/domain/places";
import type { Zone } from "../../src/domain/places";

export type LatLng = { lat: number; lng: number };
export type Pt = { x: number; y: number };

/** The drawing surface. Wide and short because the town is: 2.5 km by 1.3 km. */
export const VIEW = { w: 1120, h: 580 };

// ── The projection ───────────────────────────────────────────────────────────

/**
 * Equirectangular with a `cos(lat)` correction, anchored on the Parque Central —
 * the same maths as `places.ts:distanceKm`, deliberately, so a distance measured
 * on this map in kilometres and one measured by the domain agree. The one
 * difference is that `cos` is taken at the anchor rather than at each pair's
 * midpoint, which over a 2 km town is a relative error of about 1e-5: a
 * centimetre. In exchange the projection is affine, and an affine projection is
 * what makes the drawn Voronoi boundaries below exactly the domain's own.
 */
const ANCHOR: LatLng = { lat: 14.8397, lng: -89.1531 };
const EARTH_KM = 6371;
const RAD = Math.PI / 180;
const KM_PER_DEG_LNG = RAD * Math.cos(ANCHOR.lat * RAD) * EARTH_KM;
const KM_PER_DEG_LAT = RAD * EARTH_KM;

export const PX_PER_KM = 330;

/**
 * Which point of the town lands in the middle of the frame, in kilometres east
 * and north of the anchor. Not zero: the built-up part of town sits west of the
 * ruins road, so centring on the Parque Central would leave the right third of
 * the frame empty and crowd Barrio abajo against the bottom edge.
 */
const FRAME_CENTER_KM = { x: 0.285, y: 0.105 };

export function project(p: LatLng): Pt {
  return {
    x: VIEW.w / 2 + ((p.lng - ANCHOR.lng) * KM_PER_DEG_LNG - FRAME_CENTER_KM.x) * PX_PER_KM,
    y: VIEW.h / 2 - ((p.lat - ANCHOR.lat) * KM_PER_DEG_LAT - FRAME_CENTER_KM.y) * PX_PER_KM,
  };
}

// ── The zones ────────────────────────────────────────────────────────────────

/**
 * Where each zone's name is written, and how the name breaks across lines.
 *
 * Hand-placed rather than put at the polygon's centroid: two of the six
 * polygons are crescents once clipped, whose centroid falls outside them, and
 * all six have to dodge the landmark dots.
 */
type ZoneLabel = { at: Pt; lines: string[] };

/**
 * A zone as drawn: the hand-authored blob, clipped to the zone's Voronoi cell.
 *
 * `tint` cycles 1-2-3 so that no two zones sharing a border get the same fill.
 * Six distinct fills would be a rainbow; three is enough to read the partition.
 */
export type TownZone = {
  id: string;
  polygon: Pt[];
  label: ZoneLabel;
  tint: 1 | 2 | 3;
};

/**
 * The built-up shape of each zone, before clipping.
 *
 * Authored in viewBox pixels, not in coordinates, because these are a drawing
 * and there is no survey to be faithful to — the seed says so itself. They are
 * drawn generously, overlapping their neighbours: the shared borders come out of
 * the clip, which puts them exactly on the line the domain uses.
 */
const ZONE_BLOBS: { id: string; label: ZoneLabel; tint: 1 | 2 | 3; blob: number[][] }[] = [
  {
    id: "centro",
    tint: 1,
    label: { at: { x: 490, y: 288 }, lines: ["Centro"] },
    blob: [
      [300, 300], [356, 258], [430, 242], [500, 246], [560, 272],
      [590, 320], [574, 376], [506, 404], [430, 404], [352, 382], [310, 346],
    ],
  },
  {
    id: "barrio_arriba",
    tint: 2,
    label: { at: { x: 424, y: 252 }, lines: ["Barrio arriba"] },
    blob: [
      [326, 150], [394, 136], [458, 150], [494, 188], [502, 234],
      [472, 282], [404, 298], [338, 286], [296, 258], [300, 196],
    ],
  },
  {
    id: "barrio_abajo",
    tint: 2,
    label: { at: { x: 352, y: 390 }, lines: ["Barrio abajo"] },
    blob: [
      [272, 354], [344, 350], [420, 372], [470, 412], [464, 468],
      [414, 500], [344, 496], [290, 466], [264, 410],
    ],
  },
  {
    id: "salida_florido",
    tint: 3,
    label: { at: { x: 206, y: 240 }, lines: ["Salida a", "El Florido"] },
    blob: [
      [122, 232], [180, 196], [250, 196], [310, 226], [344, 272],
      [330, 326], [268, 352], [194, 346], [136, 308], [112, 268],
    ],
  },
  {
    id: "salida_entrada",
    tint: 3,
    label: { at: { x: 724, y: 352 }, lines: ["Salida a", "La Entrada"] },
    blob: [
      [648, 348], [712, 328], [782, 340], [826, 378], [822, 432],
      [776, 462], [704, 456], [656, 420], [638, 382],
    ],
  },
  {
    id: "ruinas",
    tint: 1,
    label: { at: { x: 874, y: 272 }, lines: ["Las Ruinas"] },
    blob: [
      [798, 262], [860, 242], [928, 258], [958, 300], [944, 352],
      [884, 380], [800, 372], [782, 322],
    ],
  },
];

/**
 * The seeded zone centroids, projected. These are the sites of the Voronoi
 * diagram the domain reasons with, `aldeas` included — it has no polygon
 * because its centroid is off the frame, but it still competes for the corner,
 * so leaving it out of the clip would let another zone be drawn over land the
 * domain would call Aldeas.
 */
const CENTROIDS: { id: string; at: Pt }[] = [
  { id: "centro", at: project({ lat: 14.8397, lng: -89.1531 }) },
  { id: "ruinas", at: project({ lat: 14.84, lng: -89.1417 }) },
  { id: "barrio_arriba", at: project({ lat: 14.8425, lng: -89.1545 }) },
  { id: "barrio_abajo", at: project({ lat: 14.837, lng: -89.1548 }) },
  { id: "salida_florido", at: project({ lat: 14.8412, lng: -89.161 }) },
  { id: "salida_entrada", at: project({ lat: 14.8378, lng: -89.1455 }) },
  { id: "aldeas", at: project({ lat: 14.85, lng: -89.17 }) },
];

/**
 * Which zone the domain would put a drawn point in.
 *
 * `zoneForPoint` compares `distanceKm` to every centroid and takes the nearest;
 * because the projection is affine, nearest-in-kilometres and nearest-in-pixels
 * are the same ranking, so this can be answered without going back through
 * latitude and longitude.
 */
export function zoneOfPoint(p: Pt): string {
  let best = CENTROIDS[0]!;
  let bestD = Infinity;
  for (const c of CENTROIDS) {
    const d = (p.x - c.at.x) ** 2 + (p.y - c.at.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best.id;
}

/**
 * Clip a polygon to one Voronoi cell, one half-plane per rival centroid.
 *
 * Sutherland–Hodgman. The inside test is affine in the point — the difference of
 * two squared distances cancels the quadratic term — so each clip is a straight
 * line and the result stays a simple polygon.
 */
function clipToCell(blob: Pt[], own: Pt, rivals: Pt[]): Pt[] {
  let poly = blob;
  for (const rival of rivals) {
    const inside = (p: Pt): number =>
      (p.x - rival.x) ** 2 + (p.y - rival.y) ** 2 - ((p.x - own.x) ** 2 + (p.y - own.y) ** 2);

    const next: Pt[] = [];
    for (let i = 0; i < poly.length; i += 1) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const fa = inside(a);
      const fb = inside(b);
      if (fa >= 0) next.push(a);
      if (fa >= 0 !== fb >= 0) {
        const t = fa / (fa - fb);
        next.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    poly = next;
    if (poly.length === 0) break;
  }
  return poly;
}

export const ZONES: TownZone[] = ZONE_BLOBS.map((z) => {
  const own = CENTROIDS.find((c) => c.id === z.id);
  if (!own) throw new Error(`demo town: no seeded centroid for zone ${z.id}`);
  return {
    id: z.id,
    polygon: clipToCell(
      z.blob.map(([x, y]) => ({ x: x!, y: y! })),
      own.at,
      CENTROIDS.filter((c) => c.id !== z.id).map((c) => c.at),
    ),
    label: z.label,
    tint: z.tint,
  };
});

// ── The road graph ───────────────────────────────────────────────────────────

/**
 * How a road is drawn. No effect on routing: a track and a highway between the
 * same two nodes are the same number of pixels, and pixels are all the graph
 * contributes (R3).
 */
export type RoadClass = "highway" | "street" | "track";

type NodeKind = "landmark" | "zone" | "cross" | "gate";

type TownNode = { id: string; at: Pt; kind: NodeKind };

/** A landmark's node is its own id, so `nodeFor` needs no table for these. */
function landmarkNode(id: string, coords: LatLng): TownNode {
  return { id, at: project(coords), kind: "landmark" };
}

function crossNode(id: string, x: number, y: number): TownNode {
  return { id, at: { x, y }, kind: "cross" };
}

/**
 * The nodes. Landmark and zone-anchor positions are projections of the seeded
 * coordinates; everything else is invented street furniture.
 *
 * The coordinates written out below are a copy of the seed's, which is why
 * `Gazetteer.load` refuses to start when they drift more than a pixel and a half
 * apart: the graph is built at module scope, before any database exists, so there
 * is nowhere to read them from. A survey that moves a pin therefore moves two
 * lines, and the assertion is what makes the second one impossible to forget —
 * `macaw_mountain` and `salida_sps` both moved once already.
 *
 * The invented nodes exist so routes bend like streets. Without them every path
 * is a straight line between two landmarks, which on a map with blocks on it
 * reads as a taxi driving through people's houses.
 *
 * The gate nodes are the one place where a position is *not* a projection, and
 * they cannot be: Frontera El Florido is 4.8 km west of the Parque Central and
 * Agua Caliente 5.6 km north, so a literal projection would squeeze the town
 * into a tenth of the frame to fit four places nobody looks at.
 */
const NODES: TownNode[] = [
  // Centro — six landmarks strung along one street, which is what the seeded
  // coordinates actually describe: they fall on a 180 m north-west/south-east line.
  landmarkNode("hotel_marina", { lat: 14.8399, lng: -89.1528 }),
  landmarkNode("parque_central", { lat: 14.8397, lng: -89.1531 }),
  landmarkNode("iglesia", { lat: 14.8396, lng: -89.1533 }),
  landmarkNode("banco", { lat: 14.8395, lng: -89.1536 }),
  landmarkNode("mercado", { lat: 14.8393, lng: -89.1538 }),
  landmarkNode("terminal", { lat: 14.8389, lng: -89.1543 }),
  crossNode("x:calle_norte", 498, 300),
  crossNode("x:calle_sur", 400, 372),
  crossNode("x:entrada_oeste", 372, 310),

  // Barrio arriba, uphill to the north.
  { id: "z:barrio_arriba", at: project({ lat: 14.8425, lng: -89.1545 }), kind: "zone" },
  landmarkNode("hospital", { lat: 14.8428, lng: -89.1549 }),
  landmarkNode("escuela_arriba", { lat: 14.843, lng: -89.1541 }),
  landmarkNode("mirador", { lat: 14.8438, lng: -89.1552 }),
  crossNode("x:arriba_sur", 470, 262),
  crossNode("x:aldea_fork", 430, 120),
  crossNode("x:oeste_arriba", 300, 225),

  // Barrio abajo, downhill toward the river.
  { id: "z:barrio_abajo", at: project({ lat: 14.837, lng: -89.1548 }), kind: "zone" },
  landmarkNode("estadio", { lat: 14.8365, lng: -89.1552 }),
  landmarkNode("cementerio", { lat: 14.8358, lng: -89.1544 }),
  landmarkNode("rio", { lat: 14.8372, lng: -89.156 }),
  crossNode("x:puente", 390, 396),

  // West: the El Florido road out to the Guatemalan border.
  { id: "z:salida_florido", at: project({ lat: 14.8412, lng: -89.161 }), kind: "zone" },
  landmarkNode("gasolinera", { lat: 14.8408, lng: -89.1595 }),
  crossNode("x:florido_curva", 300, 296),

  // East: the highway to the ruins, and the turn-off to the airstrip.
  { id: "z:salida_entrada", at: project({ lat: 14.8378, lng: -89.1455 }), kind: "zone" },
  landmarkNode("aeropuerto", { lat: 14.837, lng: -89.144 }),
  landmarkNode("salida_sps", { lat: 14.8355, lng: -89.147 }),
  landmarkNode("parque_arq", { lat: 14.84, lng: -89.1417 }),
  landmarkNode("museo", { lat: 14.8402, lng: -89.1421 }),
  crossNode("x:oriente", 566, 330),
  crossNode("x:desvio", 690, 352),
  crossNode("x:sur_este", 560, 442),

  // The hill road north-east, past Macaw Mountain.
  landmarkNode("macaw_mountain", { lat: 14.843, lng: -89.1445 }),
  crossNode("x:hill", 592, 168),

  // The gates. Positions invented; see the note above.
  { id: "frontera", at: { x: 78, y: 258 }, kind: "gate" },
  { id: "z:aldeas", at: { x: 122, y: 150 }, kind: "gate" },
  { id: "el_jaral", at: { x: 96, y: 126 }, kind: "gate" },
  { id: "sesesmil", at: { x: 500, y: 96 }, kind: "gate" },
  { id: "agua_caliente", at: { x: 700, y: 100 }, kind: "gate" },
];

const NODE_BY_ID = new Map(NODES.map((n) => [n.id, n]));

/**
 * The streets. Bidirectional, weighted by pixel length.
 *
 * Hand-authored as a list of runs rather than pairs: a street is a run of nodes,
 * and writing them that way is how the grid stays legible to the next person
 * who has to move a block.
 */
const ROAD_RUNS: { cls: RoadClass; run: string[] }[] = [
  // The one street the whole gazetteer sits on, from the north-west end of the
  // centre down past the market to the bus terminal.
  {
    cls: "street",
    run: [
      "x:calle_norte", "hotel_marina", "parque_central", "iglesia", "banco",
      "mercado", "terminal", "x:calle_sur",
    ],
  },
  // CA-11 west: the Parque to the gasolinera and out to the border.
  {
    cls: "highway",
    run: [
      "parque_central", "x:entrada_oeste", "x:florido_curva", "gasolinera",
      "z:salida_florido", "frontera",
    ],
  },
  // The terminal sits on the western entrance, which is why buses stop there.
  { cls: "street", run: ["terminal", "x:entrada_oeste"] },
  // CA-11 east: the Parque out to the archaeological park.
  { cls: "highway", run: ["parque_central", "x:oriente", "x:desvio", "museo", "parque_arq"] },
  // The airstrip turn-off, and the road on south toward La Entrada. Two runs and
  // not one: the seeded "Carretera a La Entrada" pin sits south-west of the
  // airstrip, so stringing them together would draw the highway east past the
  // aerodrome and then back on itself.
  { cls: "highway", run: ["x:desvio", "z:salida_entrada", "aeropuerto"] },
  { cls: "highway", run: ["z:salida_entrada", "salida_sps"] },
  { cls: "street", run: ["aeropuerto", "parque_arq"] },
  // The southern ring, joining Barrio abajo to the airstrip road without
  // going back through the middle of town.
  { cls: "street", run: ["z:barrio_abajo", "x:sur_este", "z:salida_entrada"] },
  // North out of the centre into Barrio arriba.
  {
    cls: "street",
    run: ["x:calle_norte", "x:arriba_sur", "z:barrio_arriba", "hospital", "mirador"],
  },
  { cls: "street", run: ["z:barrio_arriba", "escuela_arriba"] },
  { cls: "street", run: ["escuela_arriba", "x:arriba_sur"] },
  // West along the hillside, so a driver at the hospital is not routed through
  // the Parque to reach the gasolinera.
  { cls: "street", run: ["hospital", "x:oeste_arriba", "z:salida_florido"] },
  // South out of the centre, over the bridge.
  {
    cls: "street",
    run: ["x:calle_sur", "x:puente", "z:barrio_abajo", "estadio", "cementerio"],
  },
  { cls: "street", run: ["x:puente", "rio", "z:barrio_abajo"] },
  { cls: "street", run: ["cementerio", "x:sur_este"] },
  // The hill road: up past Macaw Mountain and on to the aldeas to the north.
  { cls: "track", run: ["x:arriba_sur", "x:hill", "macaw_mountain"] },
  { cls: "track", run: ["x:hill", "agua_caliente"] },
  { cls: "track", run: ["mirador", "x:aldea_fork", "sesesmil"] },
  { cls: "track", run: ["x:aldea_fork", "z:aldeas", "el_jaral"] },
];

/** Every road segment, for drawing. */
export const ROADS: { a: Pt; b: Pt; cls: RoadClass }[] = [];

/** Adjacency, for routing. */
const NEIGHBOURS = new Map<string, { to: string; cost: number }[]>();

for (const { cls, run } of ROAD_RUNS) {
  for (let i = 0; i + 1 < run.length; i += 1) {
    const a = NODE_BY_ID.get(run[i]!);
    const b = NODE_BY_ID.get(run[i + 1]!);
    if (!a || !b) throw new Error(`demo town: road run names a missing node (${run[i]}→${run[i + 1]})`);
    ROADS.push({ a: a.at, b: b.at, cls });
    const cost = Math.hypot(b.at.x - a.at.x, b.at.y - a.at.y);
    push(NEIGHBOURS, a.id, { to: b.id, cost });
    push(NEIGHBOURS, b.id, { to: a.id, cost });
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// ── Gateways ─────────────────────────────────────────────────────────────────

/**
 * A place off the frame, drawn as an arrow at the border.
 *
 * `gate` is where the road reaches the edge and where the sprite is parked when
 * the domain believes the driver is out there; `tip` is the vanishing point it
 * fades out toward. Driving off the edge and back is both prettier than a taxi
 * pinned to the frame and truer to how those trips feel from town.
 */
export type Gateway = {
  /** The node the road ends at — a landmark id or `z:aldeas`. */
  node: string;
  gate: Pt;
  tip: Pt;
  label: Pt;
  anchor: "start" | "middle" | "end";
  lines: string[];
  /**
   * Whether a taxi bound here drives off the frame and fades, or stops at the
   * gate. Only true where the place is genuinely off the map: parking a sprite
   * out of sight is the right picture for the Guatemalan border and the wrong
   * one for El Jaral, which is drawn at the edge and should stay visible.
   */
  leaves: boolean;
};

export const GATEWAYS: Gateway[] = [
  {
    node: "frontera",
    gate: { x: 78, y: 258 },
    tip: { x: 18, y: 246 },
    label: { x: 14, y: 300 },
    anchor: "start",
    lines: ["Frontera", "El Florido"],
    leaves: true,
  },
  {
    node: "z:aldeas",
    gate: { x: 122, y: 150 },
    tip: { x: 30, y: 100 },
    label: { x: 14, y: 54 },
    anchor: "start",
    lines: ["Aldeas", "El Jaral"],
    leaves: false,
  },
  {
    node: "sesesmil",
    gate: { x: 500, y: 96 },
    tip: { x: 492, y: 32 },
    label: { x: 492, y: 22 },
    anchor: "middle",
    lines: ["Sesesmil"],
    leaves: true,
  },
  {
    node: "agua_caliente",
    gate: { x: 700, y: 100 },
    tip: { x: 710, y: 32 },
    label: { x: 710, y: 22 },
    anchor: "middle",
    lines: ["Agua Caliente"],
    leaves: true,
  },
  /**
   * The odd one out: "Carretera a La Entrada" is a real projection well inside the
   * frame, so no sprite ever leaves through here and `gate` is the node itself
   * rather than an invented pixel. The arrow is still worth drawing — it is what
   * tells a viewer the road carries on to San Pedro Sula, seventy kilometres past
   * the bottom of the picture.
   *
   * That the pin is *inside* town at all is the same tell the seed's header gives
   * about Frontera El Florido: it was pulled back until it snapped to the zone it
   * is declared in. What is drawn here is where the road leaves, not where the
   * carretera goes.
   */
  {
    node: "salida_sps",
    gate: project({ lat: 14.8355, lng: -89.147 }),
    tip: { x: 754, y: 552 },
    label: { x: 768, y: 546 },
    anchor: "start",
    lines: ["Carretera a", "La Entrada"],
    leaves: false,
  },
];

const GATE_BY_NODE = new Map(GATEWAYS.map((g) => [g.node, g]));

// ── Routing ──────────────────────────────────────────────────────────────────

/** Dijkstra. Thirty-odd nodes, so a linear scan for the next node is free. */
function shortestPath(fromId: string, toId: string): string[] {
  if (fromId === toId) return [fromId];

  const dist = new Map<string, number>([[fromId, 0]]);
  const prev = new Map<string, string>();
  const settled = new Set<string>();

  for (;;) {
    let current: string | null = null;
    let best = Infinity;
    for (const [id, d] of dist) {
      if (!settled.has(id) && d < best) {
        best = d;
        current = id;
      }
    }
    if (current === null) break;
    if (current === toId) break;
    settled.add(current);

    for (const edge of NEIGHBOURS.get(current) ?? []) {
      const next = best + edge.cost;
      if (next < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, next);
        prev.set(edge.to, current);
      }
    }
  }

  if (!dist.has(toId)) return [];
  const path: string[] = [toId];
  for (let at = toId; prev.has(at); ) {
    at = prev.get(at)!;
    path.unshift(at);
  }
  return path;
}

/** The node nearest a loose point — where a sprite joins the street network. */
function nearestNode(p: Pt): TownNode {
  let best = NODES[0]!;
  let bestD = Infinity;
  for (const n of NODES) {
    const d = (n.at.x - p.x) ** 2 + (n.at.y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/**
 * A drivable polyline from one loose point to another.
 *
 * The endpoints are kept exactly: a customer waits at their pin, not at the
 * nearest intersection, and a taxi that stopped mid-block starts from there.
 */
export function route(from: Pt, to: Pt): Pt[] {
  const a = nearestNode(from);
  const b = nearestNode(to);
  const ids = a.id === b.id ? [a.id] : shortestPath(a.id, b.id);
  if (ids.length === 0) {
    // Unreachable. `loadTown` asserts this cannot happen for any seeded place,
    // so getting here means a node was added without an edge.
    return [from, to];
  }

  const pts: Pt[] = [from];
  for (const id of ids) {
    const at = NODE_BY_ID.get(id)!.at;
    const last = pts[pts.length - 1]!;
    if (Math.hypot(at.x - last.x, at.y - last.y) > 0.5) pts.push(at);
  }
  const last = pts[pts.length - 1]!;
  if (Math.hypot(to.x - last.x, to.y - last.y) > 0.5) pts.push(to);
  return pts;
}

export function pathLength(pts: Pt[]): number {
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i += 1) {
    total += Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
  }
  return total;
}

/** A point along a polyline, with the direction of travel there. */
export function sampleAlong(pts: Pt[], distance: number): { at: Pt; dx: number; dy: number } {
  if (pts.length === 1) return { at: pts[0]!, dx: 1, dy: 0 };

  let left = Math.max(0, distance);
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    if (left <= len) {
      const t = left / len;
      return {
        at: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        dx: (b.x - a.x) / len,
        dy: (b.y - a.y) / len,
      };
    }
    left -= len;
  }

  const a = pts[pts.length - 2]!;
  const b = pts[pts.length - 1]!;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { at: b, dx: (b.x - a.x) / len, dy: (b.y - a.y) / len };
}

/**
 * How visible a sprite is at a point, so a taxi bound for the border leaves
 * town rather than parking on the frame.
 *
 * Distance past the gate, not distance from the edge, because the gates are not
 * all the same distance in — `salida_sps` is a real projected position well
 * inside the frame and must never fade.
 */
export function fadeAt(p: Pt): number {
  for (const g of GATEWAYS) {
    if (!g.leaves) continue;
    const vx = g.tip.x - g.gate.x;
    const vy = g.tip.y - g.gate.y;
    const span = vx * vx + vy * vy;

    // How far along the gate→tip line the point lies. Projected rather than
    // measured as a plain distance from the gate, so a taxi parked *at* the gate
    // or passing on a nearby street stays at full strength and only one heading
    // out of town dims.
    const along = ((p.x - g.gate.x) * vx + (p.y - g.gate.y) * vy) / span;
    if (along <= 0.15) continue;
    const off = Math.hypot(p.x - g.gate.x - vx * along, p.y - g.gate.y - vy * along);
    if (off > 40) continue;

    return Math.max(0.2, 1 - Math.min(along, 1) * 0.9);
  }
  return 1;
}

// ── The gazetteer, bound to the database ─────────────────────────────────────

/**
 * Landmark and zone positions read out of the running database, plus the
 * startup assertions.
 *
 * Read from the database rather than from a copy of the seed so that the two
 * invariants at the top of this file are checked against what the demo is
 * actually running. A future gazetteer with a landmark nobody drew fails here,
 * loudly, instead of stranding a taxi mid-demo in front of an audience.
 */
export class Gazetteer {
  private readonly landmarkNodes = new Map<string, string>();
  private readonly landmarkNames = new Map<string, string>();
  /** Keyed by rounded coordinates, so a pin can be traced back to its landmark. */
  private readonly byCoords = new Map<string, string>();
  private readonly zoneNodes = new Map<string, string>();
  private readonly zoneRanks = new Map<string, Pt>();
  private readonly zoneNames = new Map<string, string>();

  /** Every landmark with coordinates, for the dots on the map. */
  readonly dots: { id: string; name: string; at: Pt }[] = [];

  nodeForLandmark(id: string): string | null {
    return this.landmarkNodes.get(id) ?? null;
  }

  landmarkName(id: string): string | null {
    return this.landmarkNames.get(id) ?? null;
  }

  zoneName(id: string): string | null {
    return this.zoneNames.get(id) ?? null;
  }

  pointForNode(id: string): Pt {
    const node = NODE_BY_ID.get(id);
    if (!node) throw new Error(`demo town: no node ${id}`);
    return node.at;
  }

  pointForLandmark(id: string): Pt | null {
    const node = this.landmarkNodes.get(id);
    return node ? this.pointForNode(node) : null;
  }

  /**
   * How far out of town a taxi bound for this node drives, when the answer is
   * "off the map". Null for everywhere that is actually drawn.
   */
  vanishingPoint(node: string): Pt | null {
    const gateway = GATE_BY_NODE.get(node);
    return gateway?.leaves ? gateway.tip : null;
  }

  /** The rank, not the routing node — see `ZONE_RANKS`. */
  pointForZone(id: string): Pt | null {
    return this.zoneRanks.get(id) ?? null;
  }

  /**
   * Where this particular driver stands in that zone's rank.
   *
   * A zone drawn entirely off the frame has no rank to stand in, so its drivers
   * wait at whichever of its gateways they are nearest — which, after a trip out
   * there, is the one they just drove through. Parking every Aldeas driver at
   * one gate instead would send a taxi that had just reached Agua Caliente on a
   * pointless drive along the top of the map to stand somewhere else.
   */
  parkingSpot(zoneId: string | null, driverId: number, near?: Pt): Pt | null {
    const gates = OUTLYING_GATES[zoneId ?? ""];
    if (gates) {
      const points = gates.map((id) => this.pointForNode(id));
      // With nowhere to be near — a driver seeded out there, before any trip —
      // the first gate listed is the one whose plaque carries the zone's name.
      const gate = near ? nearestOf(points, near) : points[0]!;
      // Fanned sideways and not into the rank's two rows: the outward direction
      // at a gateway is where sprites fade out, and a slot placed along it would
      // dim a taxi that is standing still.
      return { x: gate.x + ((driverId % 3) - 1) * 26, y: gate.y };
    }

    const rank = this.zoneRanks.get(zoneId ?? "");
    if (!rank) return null;
    const slot = RANK_SLOTS[(driverId - 1) % RANK_SLOTS.length]!;
    return { x: rank.x + slot.x, y: rank.y + slot.y };
  }

  /**
   * Where to draw a pin.
   *
   * A coordinate is looked up as a landmark first. Every pin in the demo comes
   * from the place picker, so this is the normal path, and it is the only one
   * that gets the far landmarks right: projecting Agua Caliente literally puts
   * it 1200 px above the frame, and snapping "whatever is nearest the frame" put
   * it at the wrong gate by a margin of seven pixels.
   */
  pointForCoords(p: LatLng): Pt {
    const known = this.byCoords.get(coordKey(p));
    if (known) return this.pointForLandmark(known) ?? project(p);
    return clampToFrame(project(p));
  }

  async load(db: D1Database): Promise<void> {
    const zones = await listZones(db);
    for (const zone of zones) {
      this.zoneNames.set(zone.id, zone.name);

      // The Voronoi sites are a copy of the seeded centroids, and every drawn
      // polygon is a clip against them — so a centroid edited in the seed and
      // not here would move `zoneForPoint` while the drawing stayed put, and
      // pins would quietly be scored in a zone other than the one they are
      // drawn in. That is precisely the failure the clipping exists to prevent,
      // so the copy is checked rather than trusted.
      const site = CENTROIDS.find((c) => c.id === zone.id);
      if (!site) throw new Error(`demo town: zone ${zone.id} is missing from CENTROIDS`);
      const drift = Math.hypot(...offset(project(zone), site.at));
      if (drift > 1.5) {
        throw new Error(
          `demo town: zone ${zone.id} is seeded at ${zone.lat},${zone.lng} but CENTROIDS ` +
            `puts it ${drift.toFixed(0)} px away — the drawn zones would be wrong`,
        );
      }
      const node = ZONE_ANCHOR_NODES[zone.id];
      if (!node || !NODE_BY_ID.has(node)) {
        throw new Error(`demo town: zone ${zone.id} has nowhere to park a taxi`);
      }
      this.zoneNodes.set(zone.id, node);
      const rank = ZONE_RANKS[zone.id];
      if (!rank) throw new Error(`demo town: zone ${zone.id} has no rank in town.ts`);
      this.zoneRanks.set(zone.id, rank);
    }

    const { results } = await db
      .prepare("SELECT id, name, lat, lng FROM landmarks WHERE active = 1")
      .all<{ id: string; name: string; lat: number | null; lng: number | null }>();

    for (const lm of results) {
      this.landmarkNames.set(lm.id, lm.name);
      if (!NODE_BY_ID.has(lm.id)) {
        throw new Error(
          `demo town: landmark "${lm.id}" has no node — a taxi sent there would ` +
            `never arrive. Add it to NODES and to a road run in town.ts.`,
        );
      }
      this.landmarkNodes.set(lm.id, lm.id);
      if (lm.lat !== null && lm.lng !== null) {
        const seeded: LatLng = { lat: lm.lat, lng: lm.lng };
        this.byCoords.set(coordKey(seeded), lm.id);
        const node = NODE_BY_ID.get(lm.id)!;
        // A gate's position is invented, so it is the one kind that may not
        // match; everything else must be where the seed says it is, or the map
        // is drawing a place at coordinates the domain scores from elsewhere.
        if (node.kind !== "gate") {
          const drawn = project(seeded);
          const off = Math.hypot(drawn.x - node.at.x, drawn.y - node.at.y);
          if (off > 1.5) {
            throw new Error(
              `demo town: landmark "${lm.id}" is seeded at ${lm.lat},${lm.lng} but its node ` +
                `in town.ts is ${off.toFixed(0)} px away — update NODES`,
            );
          }
          this.dots.push({ id: lm.id, name: lm.name, at: node.at });
        }
      }
    }

    assertConnected();
    assertPolygonsHonest();
    assertRanksHonest();
    await assertMatrixCovers(db, zones);
  }
}

/**
 * The taxi rank in each zone: where an idle driver is drawn, where a trip with
 * no pin is picked up, and where a trip to a zone rather than a landmark ends.
 *
 * Deliberately not the zone's centroid. Half the centroids coincide with a
 * landmark — `centro` is the Parque Central to five decimal places — so parking
 * there buries the busiest dot on the map under a sprite, and the zone's own
 * name under the sprite's number badge. Every rank below sits inside its zone's
 * Voronoi cell, which `assertRanksHonest` checks: a rank a few metres over the
 * line would draw an idle taxi in a zone the dispatcher would not score it in.
 */
const ZONE_RANKS: Record<string, Pt> = {
  centro: { x: 530, y: 330 },
  ruinas: { x: 900, y: 346 },
  barrio_arriba: { x: 452, y: 178 },
  barrio_abajo: { x: 446, y: 432 },
  salida_florido: { x: 166, y: 300 },
  salida_entrada: { x: 706, y: 424 },
  /**
   * The exception, and the only one. Aldeas' centroid is off the frame, so its
   * cell clips to a sliver in the top-left corner that no road reaches; the rank
   * is where the track out of town crosses the border instead. Nothing is drawn
   * claiming that ground for a zone, so no pin can be misread — what tells a
   * viewer where the taxi went is the gateway plaque beside it.
   */
  aldeas: { x: 122, y: 150 },
};

/**
 * Where each tuktuk stands in a rank: two rows of three, spaced so a sprite's
 * number badge clears the one below it. A driver keeps their slot all day —
 * a spot that depended on who else was parked would make an idle taxi shuffle
 * sideways whenever an unrelated driver arrived, which reads as a bug.
 */
const RANK_SLOTS: Pt[] = [
  { x: -30, y: -21 },
  { x: 0, y: -21 },
  { x: 30, y: -21 },
  { x: -30, y: 21 },
  { x: 0, y: 21 },
  { x: 30, y: 21 },
];

/**
 * Zones with no drawn extent: every gateway that stands in for part of them.
 * Only Aldeas qualifies, since it is the one zone whose whole territory is
 * beyond the frame.
 */
const OUTLYING_GATES: Record<string, string[]> = {
  aldeas: ["z:aldeas", "sesesmil", "agua_caliente"],
};

/** Which node a zone's traffic joins the road network at. */
const ZONE_ANCHOR_NODES: Record<string, string> = {
  centro: "parque_central",
  ruinas: "parque_arq",
  barrio_arriba: "z:barrio_arriba",
  barrio_abajo: "z:barrio_abajo",
  salida_florido: "z:salida_florido",
  salida_entrada: "z:salida_entrada",
  aldeas: "z:aldeas",
};

function offset(a: Pt, b: Pt): [number, number] {
  return [a.x - b.x, a.y - b.y];
}

function nearestOf(points: Pt[], to: Pt): Pt {
  let best = points[0]!;
  let bestD = Infinity;
  for (const p of points) {
    const d = (p.x - to.x) ** 2 + (p.y - to.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function coordKey(p: LatLng): string {
  // Four decimals is about eleven metres, and the seed carries exactly four.
  return `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
}

/** Keeps an unknown pin on screen rather than drawing it into the page margin. */
function clampToFrame(p: Pt): Pt {
  return {
    x: Math.min(Math.max(p.x, 20), VIEW.w - 20),
    y: Math.min(Math.max(p.y, 20), VIEW.h - 20),
  };
}

export async function loadTown(db: D1Database): Promise<Gazetteer> {
  const gazetteer = new Gazetteer();
  await gazetteer.load(db);
  return gazetteer;
}

// ── The assertions ───────────────────────────────────────────────────────────

/**
 * Every node reachable from every other.
 *
 * A second component is the failure this whole file most easily grows: adding a
 * landmark node and forgetting the road run that reaches it. On screen that is a
 * taxi that accepts a trip and then never arrives, with nothing in the console.
 */
function assertConnected(): void {
  const seen = new Set<string>([NODES[0]!.id]);
  const queue = [NODES[0]!.id];
  while (queue.length) {
    for (const edge of NEIGHBOURS.get(queue.pop()!) ?? []) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  const stranded = NODES.filter((n) => !seen.has(n.id)).map((n) => n.id);
  if (stranded.length) {
    throw new Error(`demo town: nodes unreachable on the road graph: ${stranded.join(", ")}`);
  }
}

/**
 * Every drawn zone lies inside its own Voronoi cell.
 *
 * Guaranteed by construction — the polygons are the clip — so this is a guard on
 * the clip itself and on the hand-authored blobs: a blob that misses its cell
 * entirely clips to nothing, which would otherwise show up as a zone silently
 * missing from the map.
 */
function assertPolygonsHonest(): void {
  for (const zone of ZONES) {
    if (zone.polygon.length < 3) {
      throw new Error(
        `demo town: zone ${zone.id} clipped away to nothing — its blob in ` +
          `ZONE_BLOBS does not overlap the zone's Voronoi cell`,
      );
    }
    for (const p of samplePolygon(zone.polygon)) {
      const owner = zoneOfPoint(p);
      if (owner === zone.id) continue;
      // Half a pixel of slack, because a clipped vertex sits exactly on a
      // bisector: there the two zones are equidistant and which one wins is
      // decided by rounding, not by the drawing being wrong.
      if (advantage(p, owner, zone.id) < 0.5) continue;
      throw new Error(
        `demo town: a point drawn inside ${zone.id} at ${p.x.toFixed(0)},${p.y.toFixed(0)} ` +
          `would be scored as ${owner} by zoneForPoint`,
      );
    }
  }
}

/**
 * Every rank is in the zone it belongs to.
 *
 * `aldeas` is exempt for the reason given at `ZONE_RANKS`; every other rank is
 * somewhere a taxi is drawn idling, and drawing one in the wrong zone would make
 * the map disagree with the next assignment for no visible reason.
 */
function assertRanksHonest(): void {
  for (const [id, rank] of Object.entries(ZONE_RANKS)) {
    if (id === "aldeas") continue;
    for (const slot of RANK_SLOTS) {
      const spot = { x: rank.x + slot.x, y: rank.y + slot.y };
      const owner = zoneOfPoint(spot);
      if (owner !== id) {
        throw new Error(`demo town: a slot in the ${id} taxi rank is drawn in ${owner}`);
      }
    }
  }
}

/** How many pixels nearer `winner`'s centroid is than `loser`'s, at `p`. */
function advantage(p: Pt, winner: string, loser: string): number {
  const to = (id: string): number => {
    const c = CENTROIDS.find((x) => x.id === id)!;
    return Math.hypot(p.x - c.at.x, p.y - c.at.y);
  };
  return to(loser) - to(winner);
}

/** Vertices, edge midpoints, and points pulled toward the middle. */
function samplePolygon(poly: Pt[]): Pt[] {
  const mid = {
    x: poly.reduce((s, p) => s + p.x, 0) / poly.length,
    y: poly.reduce((s, p) => s + p.y, 0) / poly.length,
  };
  const out: Pt[] = [mid];
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    for (const t of [0, 0.25, 0.5, 0.75]) {
      const edge = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      out.push(edge);
      for (const pull of [0.2, 0.5, 0.8]) {
        out.push({
          x: edge.x + (mid.x - edge.x) * pull,
          y: edge.y + (mid.y - edge.y) * pull,
        });
      }
    }
  }
  return out;
}

/**
 * Every ordered pair of zones has a travel time.
 *
 * `travelMinutes` falls back to a flat 10 for a missing row, which is sensible
 * for the app and poison for the demo: the animation would take its duration
 * from the fallback while the quote the customer read came from the same
 * fallback, so the two would agree perfectly and both be fiction.
 */
async function assertMatrixCovers(db: D1Database, zones: Zone[]): Promise<void> {
  const missing: string[] = [];
  for (const from of zones) {
    for (const to of zones) {
      const row = await db
        .prepare("SELECT minutes FROM zone_times WHERE from_zone = ? AND to_zone = ?")
        .bind(from.id, to.id)
        .first<{ minutes: number }>();
      if (!row) missing.push(`${from.id}→${to.id}`);
    }
  }
  if (missing.length) {
    throw new Error(`demo town: zone_times has no row for ${missing.join(", ")}`);
  }
  // Touched so the dependency on the domain's own accessor is not merely
  // decorative: if `travelMinutes` ever stops reading this table, this fails.
  const sanity = await travelMinutes(db, zones[0]!.id, zones[0]!.id);
  if (!(sanity > 0)) throw new Error("demo town: travelMinutes returned nothing usable");
}
