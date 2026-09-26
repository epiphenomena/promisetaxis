# Demo plan — "Una hora en Copán"

> **Status: built.** All six phases are complete and verified. This file is the
> plan as approved, with the claims that turned out wrong corrected in place and
> §14 recording everything that changed. For how to *run* the demo, read
> `demo/README.md` instead — this file is for whoever maintains it.

A single web page that shows how the tuktuk service works: a map of town in the
middle, four phones around it, and a scripted hour you can watch or drive
yourself.

Not WhatsApp. Not Cloudflare. No network. One HTML file you can open by
double-clicking it, or hand to someone on a USB stick.

---

## 1. What this is for, and how it differs from the harness

There are now two fake-WhatsApp surfaces in this repo, and they are not
redundant:

| | `src/harness.html` | `demo/` |
|---|---|---|
| Audience | us, while building | the nonprofit's board, funders, and the drivers themselves |
| Runs against | the real Worker in `wrangler dev` | nothing — all in the page |
| Needs | node, wrangler, a terminal | a browser |
| Shows | one conversation at a time | the whole town at once, moving |
| Question it answers | "does this code work?" | "what is this service?" |

The harness stays exactly as it is. Nothing in `src/` changes for the demo.

## 2. The decision that shapes everything else

**The demo runs the real dispatch code.** `demo/` imports `../src/domain/*`
directly and drives it in the browser.

This is possible because the domain turns out to be completely pure — verified,
not assumed:

- no `Date.now()` anywhere in `src/domain/` (the clock is the `now` field on
  `FlowContext`, passed in)
- no `Math.random()`
- no `crypto`, no `fetch`, no `cloudflare:` imports
- the only outside type it touches is the ambient `D1Database`
- outbound messages already leave through the `Transport` interface, which is
  precisely the seam a fake channel plugs into

So the demo needs to supply three things and gets the entire state machine for
free: a `D1Database`, a clock, and a `Transport`.

The alternative — reimplementing the flows in demo-only JavaScript — was
rejected. A demo that drifts from the app is worse than no demo: it would show
the nonprofit wait quotes, Spanish wording, and driver behaviour that the real
system doesn't produce, and every future change to `copy.ts` or the scoring rule
would silently make the demo a lie. Reuse means the demo cannot misrepresent
the app, and the nonprofit's staff editing `copy.ts` see their words in it
immediately.

What the demo does own, and the app knows nothing about: the town map, the road
graph, the sprite animation, the NPCs, and the scripted hour.

## 3. Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Una hora en Copán Ruinas   🎬 Empezar la hora  ▶ ⏸  1× 4× 12× 30×  09:14│
├─────────────┬──────────────────────────────────────────┬─────────────────┤
│ CONDUCTORES │                                          │    CLIENTES     │
│             │            ░░ Barrio arriba ░░           │                 │
│ ┌─────────┐ │         ╱                    ╲           │  ┌─────────┐    │
│ │Don José │ │    ░░░░░░  Centro  ░░░░░░──────░ Las     │  │  Ana    │    │
│ │ #3      │ │       🛺3        👤              Ruinas  │  │ 9988-…  │    │
│ │ [chat]  │ │         ╲                   ╱      🛺11  │  │ [chat]  │    │
│ │ ✅ ✋ ☕ │ │           ░░ Barrio abajo ░░              │  │ 📍 menu │    │
│ │ 🎮 tomar│ │                    🛺7  👤                │  │ 🎮 tomar│    │
│ └─────────┘ │   → El Florido            → La Entrada    │  └─────────┘    │
│ ┌─────────┐ │                                          │  ┌─────────┐    │
│ │ Marvin  │ │  centro→ruinas 7.0 ▸ 6.2 min  (aprendió) │  │ Wilmer  │    │
│ │ …       │ │                                          │  │   …     │    │
│ └─────────┘ │                                          │  └─────────┘    │
├─────────────┴──────────────────────────────────────────┴─────────────────┤
│ 09:14 Ana pidió tuktuk desde Hotel Marina → Parque Arqueológico          │
│ 09:14 Asignado: Don José (#3) · 4 min                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

Two driver phones stacked left, two customer phones stacked right, map centre,
controls on top, event log along the bottom.

Two corrections from building it. The breakpoint is **1460px**, measured, not
~1100px — below that the middle column drops under ~650px and the landmark names
stop being readable. And above the breakpoint the ticker is **not** the
full-width foot strip drawn above: it sits in the middle column under the
zone-time strip, filling the space the map doesn't use. That move is worth 82px
of phone thread, which is the difference between seeing the break refusal and
not. Below the breakpoint it returns to a strip pinned across the foot.

## 4. The rules that keep it honest

These are the load-bearing constraints. Everything else is presentation.

**R1 — One way in.** The only path into the system is `handleInbound(ctx, event)`.
NPCs and human taps both do exactly one thing: push an `InboundEvent` onto the
sim queue. There is no privileged NPC path, no "simulate assignment" shortcut.
If a beat can't be expressed as an inbound event, it isn't in the demo.

**R2 — Domain state drives the map, never the reverse.** A taxi sprite moves
because the database says that driver is on a trip. The sprite arriving is what
prompts an NPC driver to tap ✅ Listo; the tap is what changes the database.

**R3 — Trip duration comes from `travelMinutes`, not from the map.** The road
graph supplies the *shape* of a path; its *duration* is the domain's own zone
matrix, so the quote the customer reads matches the drive you watch. Sprite
speed is `pathLength / (matrixMinutes × jitter)`. Jitter is bounded to ±25% —
enough that `learnZoneTime` visibly moves, small enough that it stays plausible.
Unbounded noise here would teach the matrix nonsense on camera.

**R4 — No wall clock, no unseeded randomness, anywhere in the demo.** One sim
clock, one seeded PRNG (mulberry32), seed in the URL hash. The same hour replays
identically, so a beat that demos well stays good, and a bug found at 09:14 is
reachable again.

**R5 — Slot retention.** A customer phone slot is held while that customer has a
`pending` or `assigned` trip, and taking control pins it hard. Without this rule
the most important message in the whole demo — a queued customer finally getting
`driverOnWay` several sim-minutes later — plays to an empty slot.

## 5. Files

```
demo/
  PLAN.md                 ← this file
  README.md               how to run it, and what each beat shows
  index.html              dev shell
  build.mjs               esbuild → dist/index.html, one self-contained file
  bundle.mjs              the one esbuild entry point — loaders, and the plugin
                          that reads migrations/*.sql as a directory listing
  tsconfig.json           see the warning below — NOT "extends root, add DOM"
  d1-global.d.ts          D1's types, re-declared global
  sqljs.d.ts              declare module "sql.js" (none ship, none on DT)
  sql-text.d.ts           declare module "*.sql" for the text loader
  assets.d.ts             declare module "*.css" / "*.wasm"
  src/
    main.ts               wiring, the tick loop, the World value
    d1.ts                 D1Database shim over sql.js          ← §6
    db.ts                 openDemoDb() — real migration + seed as text
    clock.ts              sim clock, pause, time compression
    rng.ts                mulberry32
    queue.ts              the single inbound queue (R1)
    transport.ts          Transport → phone slots + ticker
    town.ts               zone polygons, road graph, gateways, projection
    fleet.ts              domain state → sprite intents (R2), pure, no DOM
    map.ts                SVG render, sprite animation           ← §7
    phone.ts              phone chrome, OutboundSpec renderer    ← §8
    slots.ts              4 slots: assignment, retention, pinning (R5)
    npc/npc.ts            shared reactive NPC base + the Cast directory
    npc/customer.ts       reactive customer NPC                  ← §9
    npc/driver.ts         reactive driver NPC
    scenario.ts           the scripted hour, beat by beat          ← §10
    press.ts              flashes the control an inbound event came from
    zonetimes.ts          the learning strip
    ticker.ts
    style.css
  verify-phase{1,3,4,5,6}.ts    the five harnesses — see §12
```

**The tsconfig line above was the plan's worst call.** "Extends root, adds DOM to
lib" is exactly what breaks: `@cloudflare/workers-types` declares HTMLRewriter's
`Element` as a global *class*, and a class member shadows the inherited DOM
interface member — so with `DOM` loaded, `el.append(node)` resolves to
`append(content: string | Response | ReadableStream)` and every line of DOM
construction fails to compile. Same for `prepend`/`before`/`after`/`remove`.
The four D1 types now come from the package's module entry and are re-declared
global in `d1-global.d.ts`, with `types: ["node"]`. The trade, stated plainly:
the demo project typechecks `src/` against DOM `fetch`/`Response` rather than the
Workers ones. Root `npm run typecheck` is unchanged and still guards the app.

Dependencies: `sql.js` and `esbuild` as **root devDependencies**, plus
`demo:dev` / `demo:build` scripts. `src/` gains no dependency and no line of
code — that, not a separate lockfile, is the separation that matters. `demo/`
imports from `../src/`; nothing in `src/` may ever import from `demo/`.

`demo/dist/` is already covered by the existing `dist/` gitignore rule.

## 6. The D1 shim

sql.js (SQLite compiled to WASM) behind a shim implementing the slice of
`D1Database` the domain actually calls: `prepare().bind().first()/all()/run()`.
Schema and seed come from the real `migrations/0001_init.sql`, loaded as text at
build time, so the demo can never run against a stale schema.

(It came to ~220 lines, not the 90 estimated here, once written in this repo's
comment voice. One shape detail the plan had wrong: `D1Result<T>` is
`D1Response & { results: T[] }`, so `results` is required on `run()` too, not
only on `all()` — `implements D1PreparedStatement` will not compile otherwise.
`run()` returns `results: []` and delegates, which is what D1 itself does, since
a `RETURNING` clause has to land somewhere.)

`batch()` is only used in `src/routes/dev.ts`, which the demo does not import.
Don't build it.

Five places where getting the shim subtly wrong produces a demo that looks fine
and behaves wrong:

1. **`PRAGMA foreign_keys = ON`.** sql.js defaults it off; D1 enforces it. Skip
   this and the demo is more permissive than production.
2. **`meta.changes`** must come from `getRowsModified()` read immediately after
   the statement, before any other call. `claimDriver` (`dispatch.ts:105,116`)
   and the webhook dedup gate (`flow.ts:120`) are pure `meta.changes` logic —
   get it wrong and race handling and dedup silently invert.
3. **`meta.last_row_id`** from `sqlite3_last_insert_rowid()`. Required:
   `trips.ts:61` and `:77` return it as the new trip id, and `roster.ts:124`
   reads back a created driver.
4. **`.first()` returns `null`** for no rows, not `undefined`. The domain
   branches on `null` throughout.
5. **`messageId` must be unique and monotonic** across NPC and human input
   alike. The unique index on `events.message_id` drops duplicates silently,
   which on screen presents as "the button didn't do anything".

Also call `sweepStuckState(ctx)` on the sim tick — nearly free, matches the real
cron trigger, and keeps abandoned NPC conversations from piling up.

## 7. The map

A stylized SVG, not a tile map — which is honest, because the app doesn't use a
tile map either. Zone polygons carry the labels, since zones are the unit
routing actually works in.

Projection: equirectangular with a `cos(lat)` correction, anchored on the town,
reusing the same maths as `places.ts:distanceKm`.

**Out-of-town destinations become edge gateways.** The seeded gazetteer includes
Frontera El Florido (-89.198), Sesesmil and Agua Caliente (14.87–14.89) — a
literal projection would squeeze the town into a corner to fit them. Instead the
viewbox covers the six in-town zones, and `aldeas` plus the far landmarks are
labelled arrows at the border. A taxi headed to the border drives off the edge
and comes back. Prettier, and truer to how those trips feel.

Road graph: a hand-authored node/edge list in `town.ts`, nodes keyed to landmark
ids where the seed has coordinates, plus synthetic intersections. Dijkstra for
paths. Per R3, the graph decides the route's shape and nothing about its timing.

Sprites: 🛺 per driver with the tuktuk number, 👤 per waiting customer at their
pin. Status by colour — available, assigned, on trip, on break. Ghost trail
showing the assigned driver's approach path, so "why that driver?" is visible.

## 8. The phones

Phone chrome plus a renderer for each `OutboundSpec` kind: `text` (with `*bold*`),
`buttons`, `list`, `locationRequest`, `location` (as a little map card). The
harness already solved this problem; lift its approach rather than its code —
the spec shapes and the Spanish come from the real domain either way, and that's
the part that has to be right.

Header per phone: name, formatted phone number via the real `formatPhone`, and
for drivers the tuktuk number and status.

**Take control** (🎮 *tomar el control*): suspends that phone's NPC, pins the
slot, and makes buttons, list rows and the text input live. Everything typed or
tapped becomes an ordinary `InboundEvent` (R1), so a human is indistinguishable
from an NPC as far as the system is concerned. Release hands it back.

One deliberate wrinkle: if a human driver taps ✅ Listo before their sprite
arrives, the trip really does close early — the domain infers they're at the
destination, and the sprite glides to catch up. The ticker says so. That is the
actual behaviour of the design, and showing it is more useful than hiding it.

## 9. The NPCs

Both kinds are **reactive, not scripted-blind**: an NPC reads the last outbound
spec sent to its phone and decides what to tap, then enqueues that tap at
`now + think-time`. If the bot asks something unexpected they respond sensibly
or give up, exactly like a person — which also means the NPCs are a crude
fuzzer for the flows.

- **Customer NPC** — a name, a phone, a pickup landmark, a destination, a spawn
  time. Opens with a greeting, sends its location when asked, picks the matching
  zone row, then the landmark row. A configurable few prefer typing to tapping,
  which is what exercises the free-text path.
- **Driver NPC** — starts a shift by sending location, then reacts: a trip
  hand-off starts a drive; sprite arrival sends `drv:done`. Scenario beats can
  make one tap ✋ Bandera or ☕ Descanso at a chosen moment.

## 10. The scripted hour

Arrival-rate tuning alone will not produce a good demo, and this is worth being
explicit about because it dictates the structure.

`assignTrip` (`dispatch.ts:144-149`) only claims drivers whose status is
`available`, while `quoteWaitMinutes` takes `candidates[0]`, which may be a
driver still mid-trip. So when the fleet is busy the honest sequence is:

1. customer picks a destination, is quoted 6 min — a number derived from a
   driver who is not free yet
2. the trip stays `pending`; the customer gets `copy.customer.queued`
3. that driver taps ✅ Listo → `onDone` → `offerNextTrip` claims the pending trip
4. *now* the customer gets `driverOnWay` and the taxi turns toward them
   (confirmed symmetric — `driver.ts:121-127` notifies the customer whether the
   trip lands on this driver or another)

That chain is the most interesting thing in the whole design, and it only
appears when the fleet is busy at the right moment. Too sparse and every hail
assigns instantly; too dense and the screen is nothing but "no hay tuktuks".

So the day is a **timeline of scripted beats** with the NPC director filling the
gaps, each beat chosen to exercise one path visibly:

| sim time | beat | what it shows |
|---|---|---|
| 09:00 | shift start — three drivers send location | cold-start position fix |
| 09:02 | Ana: Hotel Marina → Parque Arqueológico | instant assign, nearest idle driver |
| 09:05 | two hails while the fleet is busy | quote from a busy driver, `queued` |
| 09:09 | Don José taps ✅ Listo at Las Ruinas | **the chain** — steps 3–4 above |
| 09:14 | Marvin taps ✋ Bandera | flagged down, zone menu, trip logged |
| 09:17 | Marvin taps ☕ Descanso mid-trip | refused: `finishTripFirst` — the system has judgment |
| 09:19 | Marvin: ✅ Listo, then ☕ Descanso | accepted; he leaves the dispatch pool |
| 09:23 | Wilmer types "la bomba" | free-text fallback → Gasolinera → `confirmMatch` |
| 09:27 | a customer types *cancelar* while pending | cancellation, driver never disturbed |
| 09:31 | a trip runs 25% long | `learnZoneTime` moves a zone-time cell |

The last beat gets a one-line strip under the map showing the zone-time cell
that just changed.

**That beat did not survive contact, and the demo now says so on screen.** The
plan assumed a gentle 7.0 → 7.4 nudge. What actually happens is that every cell
a day touches inflates, most of them roughly doubling — measured on seed 891531:
`ruinas→centro` 7.0 → 15.95 (×2.28), `centro→barrio_abajo` 5.0 → 10.95,
`barrio_abajo→centro` 5.0 → 10.46, down to `centro→ruinas` 7.0 → 8.56 (×1.22).
Two compounding causes, both in `src/domain/trips.ts` and both real bugs — see
§13. Rather than tune the beat until it flattered a broken feedback loop, the
strip states the cause in Spanish under the number. A demo that hid this would
be worse than no demo.

The final beat list also needed rework the plan didn't anticipate: "la bomba"
cannot reach `confirmMatch` (it matches exactly one landmark, so the flow goes
straight to the trip); the day types `parque`, which matches two. And the 09:02
opener had to move — Hotel Marina → Parque Arqueológico with a driver already in
`centro` animates a 40 m approach over three sim-minutes, correct per R3 and a
taxi standing still on screen.

## 11. Build

`build.mjs` runs esbuild and emits `demo/dist/index.html`: all JS and CSS
inlined, the schema and seed SQL inlined as text, and the sql.js WASM inlined as
base64 (~1.3MB total).

The WASM must be inlined regardless of where it's hosted — on `file://`,
fetching a sibling `.wasm` is blocked, so the double-click story only works by
passing bytes straight in: `initSqlJs({ wasmBinary: base64ToBytes(WASM_B64) })`.

`npm run demo:dev` serves unbundled with watch; `npm run demo:build` produces
the one file to hand out.

## 12. Phases, each ending somewhere verifiable

All six are done. Each left a harness behind, and all of them must stay green:

| # | Phase | Proved by | Checks |
|---|---|---|---|
| 1 | D1 shim + domain in the browser | `npm run demo:verify` — full hail→assign→Listo against sql.js, printing every outbound spec | 42 |
| 2 | Clock, queue, transport, one phone | a hail completed by hand in a browser, driven by real domain code | — |
| 3 | Map, town graph, sprites | `npm run demo:verify:map` — R3 checked numerically against the board's own projection | 72 |
| 4 | Four slots, retention, take-control | `npm run demo:verify:slots` — including a negative run with R5 excised | 73 |
| 5 | NPCs + scenario + ticker | `npm run demo:verify:hour` — the full hour twice, byte-identical (R4) | 182 |
| 6 | Polish and build | `npm run demo:verify:handout` — the built file from `file://` with DNS and proxy dead | 70 |

Plus the app's own `npm test` (63) and both typechecks. Phase 1 went first
because it was the real risk: if the shim couldn't carry the domain the whole
approach changed and nothing was wasted. It carried it.

The R5 evidence is the one worth keeping: the negative run is the built bundle
with the retention flag patched to `false`, driving identical traffic. Without
the rule another customer takes Beto's slot at 09:09 and the `driverOnWay` beat
lands on a phone showing somebody else. A rule you can't show doing work usually
isn't.

## 13. What the demo found in the app

Running the real domain against real traffic surfaced four defects the 49-test
suite did not catch. **All four are now fixed**, along with a fifth that fell out
of the second. The demo stayed strictly additive to `src/` throughout — it found
them, it did not fix them; that was a separate pass, and the fixes brought their
own tests (63 now). Listed worst first, with what changed.

1. **One over-long landmark takes down a whole zone's menu.** `"Hospital /
   Centro de salud"` in `seeds/dev.sql` is 26 characters against
   `WA_MAX_ROW_TITLE = 24`, so `renderOutbound` rejects the *entire* Barrio
   arriba landmark list and the customer gets **no reply at all**. Nothing
   truncates and nothing falls back. Barrio arriba is where the hospital is.
   **This was a pilot blocker.**
   *Fixed in three layers:* the name is now `'Hospital'` (the aliases already
   carried the longer wordings); `fitRowTitle()` in `types.ts` trims any row
   title built from database text, so hand-entered gazetteer text can never
   dead-end a conversation again; and `test/gazetteer.test.ts` asserts no
   shipped name is *silently* ellipsized in front of a customer. The renderer's
   assertion is untouched — it still catches genuine programming errors.
2. **`learnZoneTime` inflates every cell it touches, and compounds.**
   `trips.ts:242` measures `doneAt − assigned_at` — approach *and* carry — and
   files it under `pickup→dest`, a cell `travelMinutes` also reads for approach
   legs. And `weight = Math.min(row.samples, 20)` is 0 for hand-seeded rows, so
   the first observation *replaces* the seeded value outright, despite the
   schema calling it "refined". An inflated cell then lengthens the next
   approach estimate, which inflates the next observation. `picked_up_at` exists
   in the schema and would make the carry leg directly observable, but nothing
   sets it for hails — by design, since there is no "picked up" button.
   *Fixed:* `migrations/0002_trip_approach_min.sql` persists the approach
   `markDriverUnderway` already computed, and `learnZoneTime` subtracts it;
   `weight = Math.max(1, …)` so a hand-seeded value is blended as one
   observation rather than erased. Re-measured over the same hour, cell drift
   went from ×1.22–×2.28 to ×0.86–×1.14 — the sprite jitter, nothing systematic.
   **The fifth bug:** the same change revealed that `onBanderaDest` was charging
   a phantom same-zone approach to a passenger already aboard, inflating
   `available_at` on every flagged-down fare. A bandera's approach is now 0.
3. **A newly registered driver can never receive a trip.** `createDriver` starts
   drivers `off`, and SETUP.md says they join dispatch on first contact. But the
   only writes setting `status = 'available'` are `onResume` — reachable only
   via the 🛺 Disponible button, which renders *only* while on break, or by
   typing "disponible"/"libre"/"regrese" — and the claim-rollback in
   `dispatch.ts:120`. Meanwhile `sendStatus` tells an `off` driver *"Está
   disponible"* while `rankCandidates` excludes them. Relatedly
   `copy.driver.askLocation` is referenced nowhere: there is no way to prompt
   for a shift-start pin.
   *Fixed:* first contact from a registered `off` driver begins their shift —
   status, `idle_since`, a `status_events` row — and the message that triggered
   it is still handled, so a first "descanso" ends on break. `askLocation` now
   has its use: a shift starting with no known position.
4. **Gazetteer self-contradictions.** `macaw_mountain` is seeded in `ruinas` but
   a pin at its coordinates snaps to `barrio_arriba`; `salida_sps` is seeded in
   `salida_entrada` but snaps to `ruinas`; and because Frontera El Florido sits
   in `salida_florido`, the matrix calls the Guatemalan border six minutes from
   the Parque Central. Placeholder data behaving exactly as `seeds/dev.sql`'s own
   header warns, but now visible on a map.
   *Fixed:* three pins moved so each snaps to its declared zone (there was a
   third contradiction — `frontera`'s pin was nearer `aldeas`), and
   `test/gazetteer.test.ts` now holds the whole gazetteer to that invariant,
   which is what matters when the survey replaces this data. **The border is
   deliberately still wrong**: one zone cannot honestly hold both "the road out
   of town" and "a border 11 km down it", and choosing between a border zone and
   taking those trips out of the matrix needs people who know Copán. The open
   question is written into `seeds/dev.sql`'s header for the survey.

## 14. Still open

- **The gazetteer is unsurveyed.** The pins are now self-consistent and guarded
  by a test, but they are still invented. Walk the town with the nonprofit
  before showing this to anyone from Copán — and settle the border question in
  `seeds/dev.sql`'s header while you are there.
- **The hour is tuned to seed 891531.** Beat minutes sit past the worst case
  the ±25% jitter allows. `#seed=` still works as an exploration hatch, but a
  different seed can desynchronise the break beat and show a spurious second
  refusal. Deliberately not pinned — removing a working tool to guard against a
  misreading seemed the worse trade.
- **The handout's hour is not asserted byte-identical to the dev server's.**
  `demo:verify:handout` proves the minified IIFE build *works* end to end, not
  that it produces the same trace as the ESM build the other harnesses check.
- **Renderer duplication.** The demo's bubble renderer and `src/harness.html`'s
  will drift. Acceptable — neither is WhatsApp, and the copy and the spec shapes
  they render both come from the one real source.
- **Publishing as a shareable link** was never tested; the local single file is
  the deliverable and it works offline from `file://`.
- **A press highlight can scroll off its own phone.** A ✅ Listo is answered with
  three bubbles, so the thread scrolls past the button that was pressed.
  Top-aligning a burst was tried and measured worse — it hid the trip card on
  two of four phones. The harness prints the overhang rather than asserting it.
- **`npm run demo:dev` is covered by none of the eight suites.** A break in the
  watch/serve wrapper would ship silently.
