/** Conversation state, one row per phone number. */

export type Role = "customer" | "driver";

export type CustomerState =
  | "idle"
  | "awaiting_location"
  | "awaiting_zone"
  | "awaiting_landmark"
  | "awaiting_text_confirm"
  | "waiting"
  | "riding";

export type DriverState = "off" | "available" | "assigned" | "on_trip" | "break";

export type SessionContext = {
  /** Customer flow. */
  pickupLat?: number;
  pickupLng?: number;
  pickupZone?: string;
  destZone?: string;
  destLandmark?: string;
  tripId?: number;
  /** Landmark ids offered in a free-text disambiguation prompt. */
  textCandidates?: string[];
  /** Driver flow: the bandera trip being described. */
  banderaTripId?: number;
};

export type Session = {
  phone: string;
  role: Role;
  state: string;
  context: SessionContext;
  windowExpiresAt: number;
};

const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function loadSession(
  db: D1Database,
  phone: string,
  defaultRole: Role,
): Promise<Session> {
  const row = await db
    .prepare(
      "SELECT phone, role, state, context_json, window_expires_at FROM sessions WHERE phone = ?",
    )
    .bind(phone)
    .first<{
      phone: string;
      role: string;
      state: string;
      context_json: string;
      window_expires_at: number;
    }>();

  if (!row) {
    return {
      phone,
      role: defaultRole,
      state: defaultRole === "driver" ? "available" : "idle",
      context: {},
      windowExpiresAt: 0,
    };
  }

  return {
    phone: row.phone,
    role: row.role as Role,
    state: row.state,
    context: safeParse(row.context_json),
    windowExpiresAt: row.window_expires_at,
  };
}

export async function saveSession(db: D1Database, s: Session, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sessions (phone, role, state, context_json, window_expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(phone) DO UPDATE SET
         role = excluded.role,
         state = excluded.state,
         context_json = excluded.context_json,
         window_expires_at = excluded.window_expires_at,
         updated_at = excluded.updated_at`,
    )
    .bind(s.phone, s.role, s.state, JSON.stringify(s.context), s.windowExpiresAt, now)
    .run();
}

/**
 * Any inbound message from a person opens a fresh free 24-hour service window.
 * Stored as a plain timestamp so it can be edited directly in D1 — that turns
 * "test the lapsed-window path" from a day of waiting into one UPDATE.
 */
export function touchWindow(s: Session, now: number): Session {
  return { ...s, windowExpiresAt: now + WINDOW_MS };
}

export function windowIsOpen(s: Session, now: number): boolean {
  return s.windowExpiresAt > now;
}

function safeParse(json: string): SessionContext {
  try {
    return JSON.parse(json) as SessionContext;
  } catch {
    return {};
  }
}
