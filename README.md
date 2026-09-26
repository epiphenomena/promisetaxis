# promisetaxis

WhatsApp-based tuktuk hailing and dispatch for **Copán Ruinas, Honduras**.

Customers hail a tuktuk by messaging a WhatsApp bot — one tap to share their
location, two taps to pick a destination. Drivers run their whole day from three
reply buttons in the same chat. The office gets a live board and trip reports.
No app to install on either side.

**Start here: [SETUP.md](SETUP.md).** Part 1 runs the entire system locally with
no accounts and no internet.

```bash
npm install && npm run db:reset && npm run dev
# → http://localhost:8787              office dashboard
# → http://localhost:8787/harness.html fake WhatsApp (dev only)
```

## Why it is built this way

**WhatsApp instead of apps.** Everyone in town already has it, it queues
messages through the outages that are normal there, and it sidesteps the
background-task problem entirely — there is no app that needs to run in the
background, because the "app" is a chat thread.

**Zone-level routing, not addresses.** Local addresses are things like "the blue
house on the hill". Streets are narrow, windy, parked-up, and randomly blocked
by an unloading truck for twenty minutes. Precision beyond "which part of town"
would be lying, so pickups and destinations resolve to zones and landmarks, and
dispatch is a lookup in a small zone-to-zone time matrix that learns from real
trips.

**Driver position is inferred, never pinged.** The trip state machine *is* the
tracking system: tapping ✅ Listo means "I am at the destination of the trip I
just closed". A driver mid-trip to Las Ruinas is scored as an
available-in-5-minutes driver *at Las Ruinas*, so drop-offs chain into nearby
pickups. No GPS polling, no data burn, no battery drain.

**Cash-first.** Fares are cash, and nothing in the system touches money. If
electronic payment is ever wanted, Tigo Money has no practical merchant API at
this scale — the realistic answer is a printed QR per driver, settled directly,
with no code involved.

## Architecture

```
WhatsApp ──webhook──> Cloudflare Worker (TypeScript + Hono) ──> D1 (SQLite)
                            │
Office dashboard ───────────┘   (gated by Cloudflare Access)
```

One Worker, one database, no servers. A busy day is roughly 2,000 requests
against a 100,000/day free-tier limit.

### The adapter boundary

The load-bearing design decision. Exactly two functions know Meta's JSON shapes:

- `parseInbound(webhookJson) → InboundEvent[]`
- `renderOutbound(OutboundMessage) → Cloud API JSON`

Everything in `src/domain/` speaks only the normalized types in
`src/domain/types.ts` and sends through a `Transport` interface. Three
transports implement it — the real Cloud API, the dev outbox that feeds the
harness, and an in-memory one for tests — and the state machines cannot tell
them apart.

That is what makes the whole system testable with no network and no phones, and
what lets the fake-WhatsApp harness be a drop-in rather than a mock.

### Layout

```
src/
  domain/          no WhatsApp shapes may appear below this line
    types.ts       the boundary: InboundEvent, OutboundSpec, Transport
    flow.ts        routes an inbound event to the right state machine
    customer.ts    text → location → zone → landmark → quote
    driver.ts      ✅ Listo · ✋ Bandera · ☕ Descanso
    dispatch.ts    scoring + the race-safe conditional claim
    trips.ts       trip lifecycle + travel-time learning
    places.ts      gazetteer, zone snapping, fuzzy landmark matching
    drivers.ts     roster CRUD + phone normalization
    sweep.ts       one-minute cron: stuck trips and unassigned hails
    copy.ts        every Spanish string, in one file
  adapters/whatsapp/
    inbound.ts     Cloud API JSON → InboundEvent
    outbound.ts    OutboundSpec → Cloud API JSON (asserts WhatsApp's limits)
    transport.ts   CloudApi | DevOutbox | Memory
    verify.ts      webhook signature + the GET handshake
  routes/
    api.ts         office board, assign, cancel, reports, CSV, roster
    dev.ts         harness endpoints (404 unless DEV_MODE)
  harness.html     fake WhatsApp page, bundled as text so its gate always applies
public/
  index.html       office dashboard — board, reports, driver roster
```

## The office dashboard

`public/index.html`, in Spanish, is what the dispatcher operates. Two tabs:

- **Tablero** — a summary strip (waiting / free / driving / on break / longest
  wait), then the waiting hails, then the fleet. Each waiting hail carries a
  severity stripe that turns amber at 3 minutes and red at 6, and a row of
  tap-to-assign chips ordered by the same score dispatch uses, with the best
  one highlighted. Refreshes every 5 seconds.
- **Reportes** — trips per driver, most frequent routes, and breaks over a
  chosen period, plus CSV export.
- **Conductores** — the roster. Add, edit, deactivate. The phone field
  normalizes whatever the office types into the exact digits Meta sends, since
  a mismatch there would silently give a driver the customer flow.

There is no login code in the repo on purpose: the Worker sits behind
Cloudflare Access, so dispatchers sign in with their email and the identity
layer lives at the edge rather than in application code.

## The harness

`public/harness.html` is a local page that renders outbound messages as chat
bubbles, lets you click the reply buttons and list rows, and posts synthetic
webhooks back to the Worker. Customer on the left, driver on the right, live
fleet state on the edge.

For a conversational app this is the highest-leverage thing in the repo: it
turns a slow physical loop — type on a phone, wait, squint — into an instant
one, and it lets Spanish-speaking staff iterate the wording in `copy.ts`
alongside you in a single sitting. It renders WhatsApp's `*bold*` markup so copy
reads the way it will in the field.

Both the page and the `/dev/*` routes it depends on return 404 unless
`DEV_MODE` is `"true"` — they inject unauthenticated inbound messages, which
would be a trivial way to spoof trips if they were reachable in production.
`DEV_MODE` defaults to `false`, and `npm run dev` turns it on with a
dev-server-only `--var` override, so no deploy can ship it enabled.

The page itself lives in `src/`, not `public/`, and is bundled into the Worker
as text. That is deliberate: static assets are served *before* the Worker runs,
so an asset can never be gated on anything.

## Tests

```bash
npm test
```

48 tests via `@cloudflare/vitest-pool-workers` — real workerd, real local D1,
per-test isolated storage, no network. Beyond the flows, they pin the things
that are easy to get wrong silently: the 3-button and 10-row ceilings, Meta
sending timestamps in seconds, webhook redelivery not closing two trips, and
concurrent claims on one driver resolving to exactly one winner.

## Status

Working end to end: both conversation flows, dispatch, the office dashboard
(live board, reports with CSV export, driver roster), and the harness.

Seed data in `seeds/dev.sql` is placeholder geography — replace it before any
pilot, see SETUP.md Part 1.
