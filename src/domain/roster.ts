/**
 * Driver roster management.
 *
 * Named `roster` rather than `drivers` so it cannot be confused with
 * `driver.ts` next door, which is the conversation state machine.
 *
 * Role detection is just "is this number in the drivers table", so the stored
 * phone must match exactly what Meta puts in a webhook's `from` field: E.164
 * digits, no `+`, no spaces. A driver saved as "9999-0001" is not a driver —
 * they silently get the customer flow and nobody can tell why. That is why
 * normalization lives here, behind tests, rather than in the form.
 */

import { getZone } from "./places";
import { activeTripForDriver } from "./trips";

/** Honduras. Bare 8-digit local numbers get this prepended. */
const HN_COUNTRY_CODE = "504";

export type DriverInput = {
  phone: string;
  name: string;
  tuktukNo?: string | null;
  zoneId?: string | null;
};

export type DriverRecord = {
  id: number;
  phone: string;
  name: string;
  tuktuk_no: string | null;
  status: string;
  zone_id: string | null;
  active: number;
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Accepts what people actually type — "9999-0001", "+504 9999 0001",
 * "504 9999 0001" — and returns the single form Meta will send.
 */
export function normalizePhone(input: string): Result<string> {
  const digits = (input ?? "").replace(/\D/g, "");

  if (!digits) return { ok: false, error: "Escriba el número de teléfono." };

  // Bare local number: assume Honduras.
  if (digits.length === 8) {
    return { ok: true, value: HN_COUNTRY_CODE + digits };
  }

  if (digits.length === 11 && digits.startsWith(HN_COUNTRY_CODE)) {
    return { ok: true, value: digits };
  }

  // Allow other country codes so a foreign volunteer's number is not rejected,
  // but keep the bounds tight enough to catch typos.
  if (digits.length >= 10 && digits.length <= 15) {
    return { ok: true, value: digits };
  }

  return {
    ok: false,
    error: "Número inválido. Use 8 dígitos (ej. 9999-0001) o el número completo con código de país.",
  };
}

/** Display form for the office UI: 504 9999-0001. */
export function formatPhone(phone: string): string {
  if (phone.length === 11 && phone.startsWith(HN_COUNTRY_CODE)) {
    const local = phone.slice(3);
    return `${HN_COUNTRY_CODE} ${local.slice(0, 4)}-${local.slice(4)}`;
  }
  return phone;
}

export async function listDrivers(db: D1Database): Promise<DriverRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT id, phone, name, tuktuk_no, status, zone_id, active
       FROM drivers ORDER BY active DESC, name`,
    )
    .all<DriverRecord>();
  return results;
}

export async function createDriver(
  db: D1Database,
  input: DriverInput,
  now: number,
): Promise<Result<DriverRecord>> {
  const validated = await validate(db, input);
  if (!validated.ok) return validated;
  const { phone, name, tuktukNo, zoneId } = validated.value;

  const clash = await db
    .prepare("SELECT id, name, active FROM drivers WHERE phone = ?")
    .bind(phone)
    .first<{ id: number; name: string; active: number }>();

  if (clash) {
    return {
      ok: false,
      error: clash.active
        ? `Ese número ya está registrado a ${clash.name}.`
        : `Ese número pertenece a ${clash.name}, que está desactivado. Actívelo en vez de crear otro.`,
    };
  }

  // New drivers start 'off' — they join dispatch when they first message the
  // bot to begin a shift, not the moment the office types their name in.
  const res = await db
    .prepare(
      `INSERT INTO drivers (phone, name, tuktuk_no, status, zone_id, projected_zone_id,
                            available_at, idle_since, active, updated_at)
       VALUES (?, ?, ?, 'off', ?, ?, 0, ?, 1, ?)`,
    )
    .bind(phone, name, tuktukNo, zoneId, zoneId, now, now)
    .run();

  const created = await db
    .prepare("SELECT id, phone, name, tuktuk_no, status, zone_id, active FROM drivers WHERE id = ?")
    .bind(res.meta.last_row_id)
    .first<DriverRecord>();

  return { ok: true, value: created! };
}

export async function updateDriver(
  db: D1Database,
  id: number,
  input: DriverInput,
  now: number,
): Promise<Result<DriverRecord>> {
  const existing = await db
    .prepare("SELECT id, phone, name, tuktuk_no, status, zone_id, active FROM drivers WHERE id = ?")
    .bind(id)
    .first<DriverRecord>();
  if (!existing) return { ok: false, error: "Ese conductor no existe." };

  const validated = await validate(db, input);
  if (!validated.ok) return validated;
  const { phone, name, tuktukNo, zoneId } = validated.value;

  const clash = await db
    .prepare("SELECT name FROM drivers WHERE phone = ? AND id <> ?")
    .bind(phone, id)
    .first<{ name: string }>();
  if (clash) return { ok: false, error: `Ese número ya está registrado a ${clash.name}.` };

  await db
    .prepare(
      `UPDATE drivers SET phone = ?, name = ?, tuktuk_no = ?, zone_id = ?,
              projected_zone_id = COALESCE(projected_zone_id, ?), updated_at = ?
       WHERE id = ?`,
    )
    .bind(phone, name, tuktukNo, zoneId, zoneId, now, id)
    .run();

  // A session is keyed by phone number. Leaving the old row behind would strand
  // a half-finished conversation under a number nobody will message again.
  if (phone !== existing.phone) {
    await db.prepare("DELETE FROM sessions WHERE phone = ?").bind(existing.phone).run();
  }

  const updated = await db
    .prepare("SELECT id, phone, name, tuktuk_no, status, zone_id, active FROM drivers WHERE id = ?")
    .bind(id)
    .first<DriverRecord>();

  return { ok: true, value: updated! };
}

/**
 * Deactivating removes a driver from dispatch without deleting them, so their
 * completed trips stay attributable in the reports.
 */
export async function setDriverActive(
  db: D1Database,
  id: number,
  active: boolean,
  now: number,
): Promise<Result<DriverRecord>> {
  const existing = await db
    .prepare("SELECT id, phone, name, tuktuk_no, status, zone_id, active FROM drivers WHERE id = ?")
    .bind(id)
    .first<DriverRecord>();
  if (!existing) return { ok: false, error: "Ese conductor no existe." };

  if (!active) {
    // Same reasoning as refusing a break mid-trip: an orphaned trip makes the
    // next ✅ Listo close the wrong one and corrupts the driver's position.
    const open = await activeTripForDriver(db, id);
    if (open) {
      return {
        ok: false,
        error: `${existing.name} tiene un viaje en curso. Espere a que lo termine.`,
      };
    }
  }

  await db
    .prepare(
      `UPDATE drivers SET active = ?, status = ?, available_at = ?, idle_since = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(active ? 1 : 0, "off", now, now, now, id)
    .run();

  await db.prepare("DELETE FROM sessions WHERE phone = ?").bind(existing.phone).run();

  const updated = await db
    .prepare("SELECT id, phone, name, tuktuk_no, status, zone_id, active FROM drivers WHERE id = ?")
    .bind(id)
    .first<DriverRecord>();

  return { ok: true, value: updated! };
}

async function validate(
  db: D1Database,
  input: DriverInput,
): Promise<Result<{ phone: string; name: string; tuktukNo: string | null; zoneId: string | null }>> {
  const name = (input.name ?? "").trim();
  if (!name) return { ok: false, error: "Escriba el nombre del conductor." };

  const phone = normalizePhone(input.phone);
  if (!phone.ok) return phone;

  const zoneId = input.zoneId?.trim() || null;
  if (zoneId && !(await getZone(db, zoneId))) {
    return { ok: false, error: "Esa zona no existe." };
  }

  const tuktukNo = input.tuktukNo?.trim() || null;

  return { ok: true, value: { phone: phone.value, name, tuktukNo, zoneId } };
}
