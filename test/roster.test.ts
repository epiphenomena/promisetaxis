/**
 * Driver roster.
 *
 * Phone normalization carries the weight here: role detection is a lookup of
 * the webhook's `from` field against drivers.phone, so a number stored in any
 * other shape makes that driver silently receive the customer flow.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  createDriver,
  formatPhone,
  listDrivers,
  normalizePhone,
  setDriverActive,
  updateDriver,
} from "../src/domain/roster";
import { MemoryTransport } from "../src/adapters/whatsapp/transport";
import { handleInbound } from "../src/domain/flow";
import { AT, CUSTOMER, DRIVER_JOSE, T0, hail, inbound, makeCtx, setupDb } from "./helpers";

beforeEach(setupDb);

describe("normalizePhone", () => {
  it("accepts the shapes office staff actually type", () => {
    // All of these are the same driver, written the way a person would.
    for (const input of [
      "9999-0001",
      "9999 0001",
      "99990001",
      "504 9999-0001",
      "+504 9999 0001",
      "+50499990001",
      "50499990001",
    ]) {
      const r = normalizePhone(input);
      expect(r.ok, `${input} should be accepted`).toBe(true);
      if (r.ok) expect(r.value, `${input} normalizes`).toBe("50499990001");
    }
  });

  it("rejects lengths that can only be typos", () => {
    for (const bad of ["", "  ", "999", "9999-000", "1234567890123456789"]) {
      expect(normalizePhone(bad).ok, `${bad} should be rejected`).toBe(false);
    }
  });

  it("keeps a non-Honduran number rather than mangling it", () => {
    const r = normalizePhone("+1 415 555 0132");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("14155550132");
  });

  it("formats for display without changing what is stored", () => {
    expect(formatPhone("50499990001")).toBe("504 9999-0001");
    // Anything not Honduran is shown as-is rather than mis-grouped.
    expect(formatPhone("14155550132")).toBe("14155550132");
  });
});

describe("createDriver", () => {
  it("stores the normalized number so webhooks match it", async () => {
    const res = await createDriver(
      env.DB,
      { phone: "9999-0055", name: "Nuevo", tuktukNo: "21", zoneId: "centro" },
      T0,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.phone).toBe("50499990055");
    // Registered but not yet working — they join dispatch by messaging the bot.
    expect(res.value.status).toBe("off");
  });

  it("a newly registered driver is recognized as a driver, not a customer", async () => {
    const tx = new MemoryTransport();
    const ctx = makeCtx(tx, T0);

    await createDriver(env.DB, { phone: "9999-0055", name: "Nuevo", zoneId: "centro" }, T0);
    // The webhook arrives in Meta's format, which is what makes the round-trip
    // through normalizePhone the whole point of this test.
    await handleInbound(ctx, {
      from: "50499990055",
      messageId: "wamid.new-driver",
      at: T0,
      payload: { kind: "text", text: "hola" },
    });

    const last = tx.last("50499990055");
    // A customer would have been asked for their location; a driver gets buttons.
    expect(last?.spec.kind).toBe("buttons");
  });

  it("can be dispatched a trip after one inbound message", async () => {
    const tx = new MemoryTransport();
    const ctx = makeCtx(tx, T0);

    // Start of the day: nobody has messaged the bot yet, which is the state the
    // roster leaves every driver in.
    await env.DB.prepare("UPDATE drivers SET status='off'").run();
    const created = await createDriver(
      env.DB,
      { phone: "9999-0055", name: "Nuevo", tuktukNo: "21", zoneId: "centro" },
      T0,
    );
    expect(created.ok).toBe(true);

    await hail(ctx, CUSTOMER, AT.parqueCentral, "ruinas", "parque_arq");
    const queued = await env.DB.prepare("SELECT state FROM trips WHERE customer_phone = ?")
      .bind(CUSTOMER)
      .first<{ state: string }>();
    // Registered but not working: nothing can be routed to them yet.
    expect(queued?.state).toBe("pending");

    tx.clear();
    await inbound(ctx, "50499990055", { kind: "text", text: "hola" });

    // Their first message is what joins them to dispatch, and the queue was
    // waiting — being told they are idle while a hail sits pending is the bug.
    const trip = await env.DB.prepare(
      `SELECT t.state, d.phone FROM trips t JOIN drivers d ON d.id = t.driver_id
       WHERE t.customer_phone = ?`,
    ).bind(CUSTOMER).first<{ state: string; phone: string }>();

    expect(trip?.phone).toBe("50499990055");
    expect(trip?.state).toBe("assigned");
    expect(tx.to("50499990055").map((m) => m.spec.kind)).toContain("buttons");
  });

  it("refuses a duplicate number and names who has it", async () => {
    const res = await createDriver(
      env.DB,
      { phone: DRIVER_JOSE, name: "Otro", zoneId: "centro" },
      T0,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Don José");
  });

  it("points at reactivation when the number belongs to a disabled driver", async () => {
    const jose = (await listDrivers(env.DB)).find((d) => d.phone === DRIVER_JOSE)!;
    await setDriverActive(env.DB, jose.id, false, T0);

    const res = await createDriver(
      env.DB,
      { phone: DRIVER_JOSE, name: "Don José otra vez", zoneId: "centro" },
      T0,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("desactivado");
  });

  it("requires a name and a real zone", async () => {
    expect((await createDriver(env.DB, { phone: "99990077", name: "  " }, T0)).ok).toBe(false);
    expect(
      (await createDriver(env.DB, { phone: "99990077", name: "X", zoneId: "no_existe" }, T0)).ok,
    ).toBe(false);
  });
});

describe("updateDriver", () => {
  it("moves the session when the phone number changes", async () => {
    const tx = new MemoryTransport();
    const ctx = makeCtx(tx, T0);
    await inbound(ctx, DRIVER_JOSE, { kind: "text", text: "hola" });

    const jose = (await listDrivers(env.DB)).find((d) => d.phone === DRIVER_JOSE)!;
    await updateDriver(
      env.DB,
      jose.id,
      { phone: "9999-0099", name: "Don José", tuktukNo: "3", zoneId: "centro" },
      T0,
    );

    // The old session is keyed by a number nobody will message again; leaving
    // it would strand a half-finished conversation.
    const stale = await env.DB.prepare("SELECT phone FROM sessions WHERE phone = ?")
      .bind(DRIVER_JOSE)
      .first();
    expect(stale).toBeNull();
  });

  it("refuses a number already taken by someone else", async () => {
    const jose = (await listDrivers(env.DB)).find((d) => d.phone === DRIVER_JOSE)!;
    const res = await updateDriver(
      env.DB,
      jose.id,
      { phone: "50499990002", name: "Don José", zoneId: "centro" },
      T0,
    );
    expect(res.ok).toBe(false);
  });
});

describe("setDriverActive", () => {
  it("refuses to deactivate someone mid-trip", async () => {
    const tx = new MemoryTransport();
    const ctx = makeCtx(tx, T0);
    await hail(ctx, CUSTOMER, AT.parqueCentral, "ruinas", "parque_arq");

    const jose = (await listDrivers(env.DB)).find((d) => d.phone === DRIVER_JOSE)!;
    const res = await setDriverActive(env.DB, jose.id, false, T0);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("viaje en curso");
  });

  it("removes a deactivated driver from dispatch but keeps their history", async () => {
    const tx = new MemoryTransport();
    const ctx = makeCtx(tx, T0);
    await hail(ctx, CUSTOMER, AT.parqueCentral, "ruinas", "parque_arq");
    await inbound(ctx, DRIVER_JOSE, { kind: "button", id: "drv:done", title: "Listo" });

    const jose = (await listDrivers(env.DB)).find((d) => d.phone === DRIVER_JOSE)!;
    expect((await setDriverActive(env.DB, jose.id, false, T0)).ok).toBe(true);

    const next = await env.DB.prepare(
      "SELECT active, status FROM drivers WHERE id = ?",
    ).bind(jose.id).first<{ active: number; status: string }>();
    expect(next?.active).toBe(0);

    // The completed trip must stay attributable, or the reports lose history.
    const trips = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM trips WHERE driver_id = ? AND state = 'done'",
    ).bind(jose.id).first<{ n: number }>();
    expect(trips?.n).toBe(1);
  });

  it("stops routing hails to a deactivated driver", async () => {
    const jose = (await listDrivers(env.DB)).find((d) => d.phone === DRIVER_JOSE)!;
    await setDriverActive(env.DB, jose.id, false, T0);

    const tx = new MemoryTransport();
    const ctx = makeCtx(tx, T0);
    await hail(ctx, CUSTOMER, AT.parqueCentral, "ruinas", "parque_arq");

    expect(tx.to(DRIVER_JOSE)).toHaveLength(0);
  });
});

describe("deactivate then reactivate", () => {
  it("does not leave a stale customer session behind", async () => {
    const tx = new MemoryTransport();
    const ctx = makeCtx(tx, T0);
    const jose = (await listDrivers(env.DB)).find((d) => d.phone === DRIVER_JOSE)!;

    await setDriverActive(env.DB, jose.id, false, T0);

    // Deactivated, they are no longer in the driver lookup, so their messages
    // fall through to the customer flow and open a customer session.
    await inbound(ctx, DRIVER_JOSE, { kind: "text", text: "hola" });
    const asCustomer = await env.DB.prepare("SELECT role, state FROM sessions WHERE phone = ?")
      .bind(DRIVER_JOSE)
      .first<{ role: string; state: string }>();
    expect(asCustomer?.role).toBe("customer");

    await setDriverActive(env.DB, jose.id, true, T0);

    // If that customer session survived reactivation, their next tap would be
    // interpreted by the customer state machine instead of the driver one.
    const cleared = await env.DB.prepare("SELECT phone FROM sessions WHERE phone = ?")
      .bind(DRIVER_JOSE)
      .first();
    expect(cleared).toBeNull();

    tx.clear();
    await inbound(ctx, DRIVER_JOSE, { kind: "button", id: "drv:done", title: "Listo" });
    const kinds = tx.to(DRIVER_JOSE).map((m) => m.spec.kind);
    // A driver gets buttons; a customer would have been asked for a location.
    expect(kinds).toContain("buttons");
    expect(kinds).not.toContain("locationRequest");
  });
});
