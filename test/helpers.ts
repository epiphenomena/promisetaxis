import { env, applyD1Migrations } from "cloudflare:test";
import { MemoryTransport } from "../src/adapters/whatsapp/transport";
import { createFlowContext, handleInbound } from "../src/domain/flow";
import type { InboundPayload } from "../src/domain/types";
import type { FlowContext } from "../src/domain/flow";
import devSeedSql from "../seeds/dev.sql?raw";

export const CUSTOMER = "50488880001";
export const DRIVER_JOSE = "50499990001";
export const DRIVER_MARVIN = "50499990002";
export const DRIVER_ROSA = "50499990003";

/** Fixed clock so travel-time arithmetic in assertions is exact. */
export const T0 = 1_700_000_000_000;

/**
 * Fresh schema + seed for one test. Isolated storage means this state is
 * discarded at the end of the test, so tests can never leak into each other.
 */
export async function setupDb(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await seed(env.DB);
}

/**
 * Fresh schema plus the gazetteer the pilot actually ships.
 *
 * The fixture in `seed()` below stays small and round so assertions can name
 * exact minutes; the guard tests need the real file instead, because their whole
 * job is to fail when the nonprofit replaces it with surveyed data that breaks
 * an invariant.
 */
export async function setupDevSeed(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

  // Split by hand: D1's `exec` wants one statement per line and the seed's
  // inserts span many. Safe because the file has no semicolon inside a string —
  // comments go first so the ones containing prose cannot be mistaken for SQL.
  const statements = devSeedSql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
}

export function makeCtx(transport: MemoryTransport, now: number = T0): FlowContext {
  return createFlowContext(env.DB, transport, now);
}

let messageCounter = 0;

/** Deliver one inbound message, as if it had arrived from Meta. */
export async function inbound(
  ctx: FlowContext,
  from: string,
  payload: InboundPayload,
  opts: { messageId?: string } = {},
): Promise<void> {
  await handleInbound(ctx, {
    from,
    messageId: opts.messageId ?? `wamid.test.${++messageCounter}`,
    at: ctx.now,
    payload,
  });
}

/** Walk a customer through the full hail: text → location → zone → landmark. */
export async function hail(
  ctx: FlowContext,
  from: string,
  place: { lat: number; lng: number },
  destZone: string,
  destLandmark: string,
): Promise<void> {
  await inbound(ctx, from, { kind: "text", text: "necesito un tuktuk" });
  await inbound(ctx, from, { kind: "location", ...place });
  await inbound(ctx, from, { kind: "list", id: `zone:${destZone}`, title: destZone });
  await inbound(ctx, from, { kind: "list", id: `lm:${destLandmark}`, title: destLandmark });
}

/** Coordinates of seeded landmarks, for readable test setup. */
export const AT = {
  parqueCentral: { lat: 14.8397, lng: -89.1531 },
  ruinas: { lat: 14.84, lng: -89.1417 },
  hospital: { lat: 14.8428, lng: -89.1549 },
  estadio: { lat: 14.8365, lng: -89.1552 },
};

async function seed(db: D1Database): Promise<void> {
  const stmts: D1PreparedStatement[] = [];

  const zones: Array<[string, string, number, number, number]> = [
    ["centro", "Centro", 1, 14.8397, -89.1531],
    ["ruinas", "Las Ruinas", 2, 14.84, -89.1417],
    ["barrio_arriba", "Barrio arriba", 3, 14.8425, -89.1545],
    ["barrio_abajo", "Barrio abajo", 4, 14.837, -89.1548],
    ["aldeas", "Aldeas / afueras", 5, 14.85, -89.17],
  ];
  for (const [id, name, order, lat, lng] of zones) {
    stmts.push(
      db
        .prepare("INSERT INTO zones (id, name, sort_order, lat, lng) VALUES (?, ?, ?, ?, ?)")
        .bind(id, name, order, lat, lng),
    );
  }

  const landmarks: Array<[string, string, string, string, number, number, number]> = [
    ["parque_central", "centro", "Parque Central", "parque,el parque,plaza", 14.8397, -89.1531, 1],
    ["mercado", "centro", "Mercado", "mercado,el mercado", 14.8393, -89.1538, 2],
    ["terminal", "centro", "Terminal de buses", "terminal,buses,la terminal", 14.8389, -89.1543, 3],
    ["parque_arq", "ruinas", "Parque Arqueológico", "ruinas,las ruinas,sitio", 14.84, -89.1417, 1],
    ["hospital", "barrio_arriba", "Hospital", "hospital,centro de salud", 14.8428, -89.1549, 1],
    ["estadio", "barrio_abajo", "Estadio", "estadio,cancha", 14.8365, -89.1552, 1],
    ["el_jaral", "aldeas", "El Jaral", "jaral,el jaral", 14.86, -89.18, 1],
  ];
  for (const [id, zone, name, aliases, lat, lng, order] of landmarks) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO landmarks (id, zone_id, name, aliases, lat, lng, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, zone, name, aliases, lat, lng, order),
    );
  }

  // Deliberately asymmetric and round, so assertions can name exact minutes.
  const times: Array<[string, string, number]> = [
    ["centro", "centro", 3], ["centro", "ruinas", 7], ["centro", "barrio_arriba", 5],
    ["centro", "barrio_abajo", 5], ["centro", "aldeas", 18],
    ["ruinas", "centro", 7], ["ruinas", "ruinas", 3], ["ruinas", "barrio_arriba", 10],
    ["ruinas", "barrio_abajo", 9], ["ruinas", "aldeas", 22],
    ["barrio_arriba", "centro", 4], ["barrio_arriba", "ruinas", 10],
    ["barrio_arriba", "barrio_arriba", 3], ["barrio_arriba", "barrio_abajo", 8],
    ["barrio_arriba", "aldeas", 18],
    ["barrio_abajo", "centro", 5], ["barrio_abajo", "ruinas", 9],
    ["barrio_abajo", "barrio_arriba", 8], ["barrio_abajo", "barrio_abajo", 3],
    ["barrio_abajo", "aldeas", 20],
    ["aldeas", "centro", 18], ["aldeas", "ruinas", 22], ["aldeas", "barrio_arriba", 18],
    ["aldeas", "barrio_abajo", 20], ["aldeas", "aldeas", 10],
  ];
  for (const [from, to, min] of times) {
    stmts.push(
      db
        .prepare("INSERT INTO zone_times (from_zone, to_zone, minutes, samples) VALUES (?, ?, ?, 0)")
        .bind(from, to, min),
    );
  }

  const drivers: Array<[string, string, string, string, string]> = [
    [DRIVER_JOSE, "Don José", "3", "available", "centro"],
    [DRIVER_MARVIN, "Marvin", "7", "available", "barrio_arriba"],
    [DRIVER_ROSA, "Doña Rosa", "11", "available", "ruinas"],
  ];
  for (const [phone, name, no, status, zone] of drivers) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO drivers (phone, name, tuktuk_no, status, zone_id, projected_zone_id,
                                available_at, idle_since, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)`,
        )
        .bind(phone, name, no, status, zone, zone),
    );
  }

  await db.batch(stmts);
}
