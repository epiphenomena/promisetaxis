# Una hora en Copán — the demo

One web page that shows what the tuktuk service is: a map of Copán Ruinas in the
middle, four WhatsApp phones around it, a log along the bottom of the middle
column, and one scripted hour — 09:00 to about 10:01 — you can watch or drive
yourself.

---

## Opening it

**The handout.** `demo/dist/index.html` — one file, about 1 MB. Double-click it.
That is the whole procedure. No server, no terminal, no internet; it works from a
USB stick on a laptop that has never seen this repository. To produce it:

```
npm run demo:build          # → demo/dist/index.html
```

**The dev server**, for working on it:

```
npm run demo:dev            # → http://127.0.0.1:8000/index.html
```

esbuild rebuilds on save and serves `demo/` unbundled. The two differ in exactly
one respect — the dev page loads its JavaScript and CSS as sibling files, the
handout has them inlined — and not in what they run. Notably the SQLite WASM is
handed over as base64 in *both*, so an engine problem cannot first appear in the
thing being handed out.

Then press **🎬 Empezar la hora**.

---

## What this is, and what it is not

**It is not WhatsApp.** The phones are drawn. Nothing is sent anywhere, no number
is real, and the green bubbles are CSS.

**It is not deployed.** There is no Cloudflare Worker behind it, no D1 database,
no network request of any kind. SQLite is compiled to WebAssembly and runs inside
the page; the schema it opens is every file in `migrations/`, applied in order,
and the town it is seeded with is `seeds/dev.sql` — all of it compiled in as text
at build time, from a directory listing rather than from a list somebody wrote.

**It is running the real dispatch code.** `demo/src/` imports `src/domain/*`
directly — `handleInbound`, `assignTrip`, `quoteWaitMinutes`, `learnZoneTime`,
`copy.ts`, all of it — and drives it in the browser. Every message on a phone,
every taxi that turns, every line in the log is the app's own code reacting to an
inbound event.

That is the point, and it has a consequence worth stating out loud when you show
it: **what you see is what the app does.** The demo cannot flatter it. Building
it found five genuine defects in the app, one of them a pilot blocker. Four are
fixed in `src/`, `seeds/` and `migrations/` now and this page is the before and
after; the fifth is a question about the town that nobody in this repository can
answer. [What the demo found](#what-the-demo-found-and-what-changed) has all five,
what changed, and what it is still fair to call a caveat.

What the demo owns, and the app knows nothing about: the town map, the road
graph, the sprites, the NPCs, and the script for the hour.

---

## The controls

| control | what it does |
|---|---|
| **🎬 Empezar la hora** | Runs the scripted hour from nine in the morning. This is the thing you came here to press. Pressing it again (**↻ Repetir la hora**) throws the whole world away and runs the same hour over, identically. |
| **▶ Correr el reloj** | The clock, and only the clock. Pause it to stop on a message and read it; anything you tap while paused still lands, stamped with the minute on screen. It does **not** start the hour. |
| **1× 4× 12× 30×** | Time compression: one minute of town time every 60, 15, 5 or 2 seconds. The page opens on 4×, which puts the whole hour in about a quarter of an hour at roughly a message every couple of seconds — that is the one to narrate over. 1× to dwell on a single exchange; 12× and 30× to see the shape of the hour at once, 30× putting all of it in about two minutes. |
| **Oscuro / Claro** | Light or dark. Unset, the page follows the machine; the button overrides it in either direction. |
| **🎮 Tomar el control** | Under each phone. Suspends that phone's NPC, pins its slot, and makes the buttons, the list rows and the text box live. Type or tap and you are indistinguishable from an NPC as far as the system is concerned. Press it again to hand the phone back — the NPC picks the conversation up wherever you left it. |
| *(nothing to press)* | **The control that was pressed lights up**, a beat before the reply lands: a reply button, a row inside the list sheet it was picked from, the pin button, the send button for something typed. It is read off the inbound event as it is delivered, so an NPC's tap and yours look the same — which is the truth, because the domain cannot tell them apart. |
| `semilla 891531` | Not a debugging leftover. The whole hour comes out of that number. |

---

## The hour, beat by beat

Sim times, at 09:00 + the minute shown. Every one of these is a person choosing
something — a pin, a tap, a typed word — and nothing else. There is no beat that
closes a trip, moves a taxi, or writes a row.

| | what happens | what to point at |
|---|---|---|
| **09:00** | Doña Rosa, Don José and Marvin each send a pin | Starting a shift is sending your location. The log names the zone each pin resolved to. |
| **09:01** | Chepe (#15) is named as absent | His tuktuk is greyed out on the map and dispatch never considers him. He would join the moment he sent anything — first contact starts a shift — and he sends nothing all morning. |
| **09:01** | The scoring rule, printed before it is used | "wait + travel" per driver, computed with dispatch's own `rankCandidates`. Nobody has to take the choice on trust. |
| **09:02** | Ana hails from the Estadio to the Parque Central | The ordinary case: nearest free driver, quoted, assigned, on his way. Watch the dashed ghost trail — that is the approach the scoring rule compared. |
| **09:06** | Marvin is flagged down in the street ✋ | The bandera path. No customer, no phone: the driver logs the trip himself through a zone menu. The log says *ya lleva al pasajero* and quotes only the ride — a flagged-down fare has no drive to the pickup, and the board no longer charges for one. |
| **09:06** | Doña Rosa takes a break ☕ | The fleet is now fully committed. There is no screen free for her, and the log says so instead of dropping somebody else's. |
| **09:07** | Beto hails anyway | **The set-up.** He is quoted 12 minutes — a number derived from a driver who is not free yet — and told he is on the list. His trip stays `pending`. Nobody is dispatched. |
| **09:08** | Marvin asks for a break mid-trip ☕ | **Refused.** `Primero termine el viaje actual…`, and the open trip card comes straight back. The system has judgment, and this is the only moment in the hour where it says no. |
| **09:12** | Don José taps ✅ Listo | **The chain — the payoff.** Closing his trip is what claims Beto's. Beto's phone lights up with `driverOnWay` five minutes after he was told to wait, and a taxi turns toward him. Nothing scheduled this; it fell out of one driver finishing. |
| **09:13** | Carla hails — Hotel Marina → **Hospital** | The same window, a second time, so it reads as a mechanism and not a coincidence. Also the zone whose menu the app could not render at all until the row-title fix: the first draft of this hour sent her there and she got no reply. |
| **09:16** | Marvin taps ✅ Listo | The chain again, cross-town. Carla waited three minutes. |
| **09:30** | Wilmer types instead of tapping | Free text. He asks for a shop nobody put in the gazetteer, is told so, tries again, and gets a "did you mean…" confirmation. Buttons fail in the field; this is what happens then. |
| **09:33** | Marvin takes his break ☕ | Accepted this time, and he leaves the dispatch pool. |
| **09:34** | Delmy picks *Otro lugar…* | The escape hatch out of the landmark menu, and queued. |
| **09:36** | Delmy writes *cancelar* | Cancelled while still pending. No driver was ever disturbed. |
| **09:37** | Doña Rosa types *disponible* | Back in the pool by keyword, not by button. |
| **09:38** | Marvin comes back 🛺 | A break that ends, as they do. |
| **09:47** | Elena, Hotel Marina → Parque Arqueológico | **The trip that teaches the matrix.** Watch the strip under the map: Centro → Las Ruinas moves off the 7 minutes somebody wrote by hand, to 6.2 — half the seeded guess, half the ride that was just driven. It is the only visible evidence that the service gets better with use. |
| **10:01** | The hour ends, and the page stops | The clock halts and the taxis with it, ▶ and the speeds go dead, and the log closes with a tally counted out of the tables: trips closed, the flagged-down one among them, the cancellation, the breaks, the matrix cells corrected. The only thing left to press is **↻ Repetir la hora**, ringed. The stop is not a clock reading — it waits for the last beat *and* the last open trip, so it can never freeze a taxi with a passenger still waiting. |

### Why the chaining beat matters

It is the most interesting thing in the design and the hardest to see.

`assignTrip` only *claims* drivers whose status is `available`, but
`quoteWaitMinutes` scores the best candidate whether or not they are free. So
when the fleet is busy, the honest sequence is: quote from a driver who is
still mid-trip → leave the trip `pending` → tell the customer they are on the
list → and then, when that driver taps ✅ Listo, `offerNextTrip` hands them the
waiting trip and the customer finds out.

A service that answered "no hay tuktuks" would be a dispatcher. This one holds
the request and settles it the moment it can, and nobody had to build a queue
manager to make that happen. The window it needs — fleet busy, customer asks
anyway — does not occur on its own at a plausible hail rate, which is why the
hour is a script and not an arrival rate.

---

## The rules that keep it honest

Five constraints. Everything else on this page is presentation; break one of
these and the demo stops being evidence about the app.

- **R1 — One way in.** The only path into the system is `handleInbound(ctx, event)`.
  NPCs and human taps both do exactly one thing: push an `InboundEvent` onto the
  sim queue. There is no privileged NPC path and no "simulate assignment"
  shortcut. If a beat cannot be expressed as an inbound event, it is not in the
  demo.
- **R2 — Domain state drives the map, never the reverse.** A sprite moves because
  the database says that driver is on a trip. The sprite *arriving* is what
  prompts an NPC driver to tap ✅ Listo; the tap is what changes the database.
- **R3 — Trip duration comes from `travelMinutes`, not from the map.** The road
  graph supplies a route's shape; its duration is the domain's own zone matrix,
  so the quote the customer reads matches the drive you watch. Sprite speed is
  `pathLength / (matrixMinutes × jitter)`, jitter bounded to ±25%.
- **R4 — No wall clock, no unseeded randomness, anywhere in `demo/src/`.** One
  sim clock, one seeded PRNG, seed in the URL hash. The same hour replays
  identically, which is what makes a beat that demos well stay good.
- **R5 — Slot retention.** A customer keeps their phone slot while they have a
  `pending` or `assigned` trip, and taking control pins it hard. Without this
  rule the most important message in the demo — a queued customer finally getting
  `driverOnWay` — plays to an empty rectangle.

---

## What the demo found, and what changed

Running the real domain against real traffic surfaced defects the test suite did
not catch — four of them, plus a fifth found while reconciling this page to the
fixes for the others. Four are fixed outright; the last is half fixed and half a
question for the survey, because it needs somebody who knows the town rather than
somebody who knows the code. Say this out loud when you present it: "we built the
demo and it found five bugs" is a better story than "look, it works", and it is
the true one.

### A landmark name that broke a whole menu — was a pilot blocker

`"Hospital / Centro de salud"` was 26 characters. `WA_MAX_ROW_TITLE` is 24,
because that is WhatsApp's limit on a list-row title, and `renderOutbound` refuses
an over-long row by throwing — which rejected the **entire Barrio arriba landmark
menu**. A customer who picked Barrio arriba as their destination got nothing back
at all and the conversation dead-ended. The first draft of this hour sent a
customer there and she never got a tuktuk; the hour was rewritten around the hole.

Both halves are fixed. The seed says `Hospital` and puts the long wording in the
aliases, where the free-text search uses it anyway; and `fitRowTitle` trims any
title built from database text before the renderer can see it, so the assertion
stays a backstop for programming errors rather than something the gazetteer can
trip. **Carla now goes to the hospital at 09:13** — that beat is the fix, on
screen. `test/gazetteer.test.ts` renders every zone's menu and holds every seeded
name to the limit by hand, so the next gazetteer hears about it from a test.

Nothing in the current seed is long enough to be trimmed, so the truncation
itself is not visible anywhere in the demo, and no beat pretends otherwise.

### `learnZoneTime` inflated every cell it touched

The zone-time strip under the map is the demo's one piece of good news, and it
used to carry a footnote disowning itself. `learnZoneTime` measured
`done_at − assigned_at` and filed it under `pickup → dest` — but `assigned_at` is
when the driver was *given* the job, not when the passenger got in, so the
measurement included the drive across town to the pickup and wrote it into a cell
that means "how long from A to B". And `travelMinutes` reads that same cell back
when it estimates the next approach, so the error fed itself.

`migrations/0002_trip_approach_min.sql` stores the approach on the trip that drove
it, and the learner subtracts it. A hand-seeded row is also blended as one
observation now rather than as none, so the first real trip *refines* the surveyed
guess instead of erasing it. The same hour, same seed, same jitter:

| cell | seeded | learned | | the same hour, without the fix | |
|---|---|---|---|---|---|
| Barrio abajo → Centro | 5.0 | 5.23 | ×1.05 | 10.46 | ×2.09 |
| Barrio arriba → Las Ruinas | 10.0 | 10.08 | ×1.01 | 13.2 † | ×1.32 |
| Centro → Barrio arriba | 5.0 | 4.48 | ×0.90 | 10.95 | ×2.19 |
| Centro → Las Ruinas | 7.0 | 6.21 | ×0.89 | 9.41 | ×1.34 |
| Las Ruinas → Centro | 7.0 | 7.97 | ×1.14 | 15.95 | ×2.28 |
| Salida a El Florido → Centro | 6.0 | 5.16 | ×0.86 | 10.31 | ×1.72 |

The right-hand column is computed from *these* trips by `demo:verify:hour`, which
prints it every run: one variable changed, everything else held. Cells used to
drift ×1.22 to ×2.28 and now sit between ×0.86 and ×1.14, which is the ±25% the
sprites are jittered by and nothing systematic.

† That row is the bandera, and its number is the one previously measured rather
than a same-run counterfactual, because its span changed too — see below.

What has *not* gone away, and the strip does not claim it has: the learner
subtracts the matrix's **estimate** of the approach, not the minutes actually
spent on it, so a slow approach leaves a few per cent of itself in the cell. That
is honest rather than a demo artefact. `picked_up_at` exists in the schema and
would make the carry leg directly observable, but nothing sets it for a hail —
by design, since there is no "passenger aboard" button and a customer must be
able to cancel right up to the ✅ Listo.

### A bandera was charged for a drive that never happened

Found while reconciling the map with the fix above. A flagged-down passenger is
already in the tuktuk, but `markDriverUnderway` still asked `travelMinutes` how
long it takes to reach the pickup — and since the pickup zone *is* the driver's
own zone, it got the same-zone answer, about three minutes, for a drive that does
not exist. Every flagged-down fare pushed `available_at` out by it, making the
driver look busier than they were. It is zero now, and `demo:verify:map` asserts
that the sprite and the board agree for a bandera the way they already did for a
hail (R3).

### A driver who was `off` could never come on

`createDriver` starts drivers `off` and SETUP.md said they join dispatch on first
contact — but nothing implemented that half, so a driver the office had just added
could never be sent a trip, while `sendStatus` cheerfully told them *"Está
disponible"*. `copy.driver.askLocation` was referenced nowhere at all.

First contact from a registered driver now starts their shift: status
`available`, a `status_events` row for the office's break reporting, the message
that triggered it still handled, and a prompt for a pin when the roster has no
home zone for them.

Chepe (#15) is still parked the whole hour, and the reason has changed: he is a driver
who did not come to work, not a driver the app cannot reach. There is no beat
that brings him on, deliberately — `test/flow.test.ts` covers that behaviour five
ways, and a fourth tuktuk appearing mid-morning would evict one of the two driver
phones that carry the whole hour and add a candidate to the scoring a few minutes
before the trip the learning beat depends on. `demo:verify:hour` asserts the
silence rather than the outcome: nothing is ever sent from his number, so nothing
should have started his shift.

### The gazetteer is still unsurveyed placeholder data — and one question is open

`seeds/dev.sql` says so at the top. Every landmark, every coordinate and every
cell of the travel-time matrix is a plausible guess written at a desk, and
anybody from Copán will spot it in ten seconds.

Two of its internal contradictions are gone: **Macaw Mountain** and **Carretera a
La Entrada** were each declared in one zone while their coordinates snapped to
another, so a pin dropped on them was scored against a different part of town
than the map showed. Both pins moved, and `test/gazetteer.test.ts` now checks the
whole gazetteer for it, so a survey that moves a pin will hear about it. The demo
map's own copies of those coordinates moved with them; `town.ts` refuses to start
if the two ever drift more than a pixel and a half apart.

The third is not a contradiction that can be fixed by moving a pin, and it is
**the open question the survey has to settle**. Frontera El Florido is the
Guatemalan border, about eleven kilometres down the road, but it is declared in
`salida_florido` — the zone whose centroid is the edge of town — so the matrix
calls it six minutes from the Parque Central. Its pin had to be pulled back to the
edge of town to satisfy the snapping rule above, and that is the tell: one zone
cannot honestly hold both "the road out of town" and "a border eleven kilometres
down it". Whether the border becomes its own zone, or trips out there stop being
routed through this matrix at all, needs people who know the town. Every quote
for that trip is wrong by a factor of several until then.

### And two smaller ones

- The demo's bubble renderer and `src/harness.html`'s will drift apart. Both
  render the same `OutboundSpec` shapes and the same `copy.ts` strings, which is
  the part that has to be right; neither is WhatsApp.
- Trip durations carry ±25% jitter so `learnZoneTime` visibly moves. It is
  seeded, so it is the same jitter every time, but it is not a measurement of
  anything.

---

## Verifying it

Eight commands, all of which have to stay green. The first three are the app's own
tests and the two typecheckers; `demo:verify` runs the domain under node; the last
three drive a real headless Chromium over the DevTools protocol by hand — no
Puppeteer, because `demo/` may not add a dependency to the app.

| command | checks | what it proves |
|---|---|---|
| `npm test` | 63 | The app's own test suite. Nothing in `demo/` may break it, because nothing in `src/` is allowed to change for the demo. |
| `npm run typecheck` | — | The Worker still typechecks, without DOM types. |
| `npm run demo:typecheck` | — | The demo typechecks, with DOM types and the same strictness as the app. |
| `npm run demo:verify` | 42 | **The D1 shim.** A full hail → quote → assign → ✅ Listo cycle runs against sql.js and produces the same outbound specs the Worker does. `meta.changes`, `last_row_id`, `.first()` returning `null`, foreign keys on. Also that every file in `migrations/` was applied: the column `0002` added is there and carries the approach the domain charged, which is the check that fails loudly instead of the demo throwing on its first trip. |
| `npm run demo:verify:map` | 72 | **The map and the town.** Every place in the gazetteer is reachable by road, every drive's duration matches `travelMinutes` to the sim-second (R3) for a hail *and* for a bandera, where the approach is zero, and taxis leave and re-enter the frame at the right gateways. |
| `npm run demo:verify:slots` | 73 | **Four slots, retention, take-control.** The same morning is run twice, once with R5 and once with it excised, and the difference is printed: without retention the queued customer's `driverOnWay` lands on a phone nobody is watching. |
| `npm run demo:verify:hour` | 182 | **The scripted hour.** It runs unattended start to finish and **stops itself** when the last beat has fired and the last trip has closed — the clock then does not move again however long the page is left open, ▶ and the speeds are dead, and the closing tally in the log matches the tables it was counted from. A second fresh page produces a byte-identical trace (R4); restarting the hour in the same page reproduces it again; a run at **30×, in the coarsest frame the clock will believe**, produces the same town once the two stamps a frame can legitimately move are masked; a run has a person take a phone mid-morning and the hour carries on coherently; and a run photographs a reply button, a list row and an NPC's own choice **mid-press**, asserting each is on the glass rather than merely set. Also proves *which* code path chained the queued trip — `offerNextTrip`, not the cron sweep — by comparing timestamps, since both end in the same words. And prints, per cell, what the matrix learned beside what the identical hour would have taught it before `learnZoneTime` was fixed. |
| `npm run demo:verify:handout` | 70 | **The thing that gets handed out.** Builds `dist/index.html`, opens it as `file://` in a Chromium launched with no way to reach the network, and runs the whole hour in it. Asserts nothing in the file points at a second file and that the only request made is the file itself; that both halves of the 09:08 refusal and the whole of Wilmer's 09:30 free-text exchange are geometrically inside the phone's glass; that no phone, at any minute of the hour, pushes its newest message off the bottom; that all three theme states are right; that the text of every migration is inside the file; and that nothing scrolls sideways from 2560px down to 860px. It also checks that a press keeps its highlight when the machine asks for less motion and loses only the settle into it, and prints the tallest message burst of the hour against the height of the thread, which is the number that says how much room the copy has left. |

The last three leave their screenshots in `demo/dist/shots/`. They are meant to
be looked at, not just counted.

---

## Notes for whoever maintains this

**The seed is load-bearing.** The beat minutes in `scenario.ts` are tuned against
seed `891531`'s jitter draws, and where a beat depends on a driver having
finished a trip it is placed past the *worst* case ±25% allows, not the expected
one. `#seed=123` in the URL still works and is a fine way to explore, but it is an
escape hatch and not a supported configuration: a different seed can desynchronise
Marvin's break from his trip completion and produce a second, spurious
`finishTripFirst` that reads like a bug. If you change the seed, re-run
`demo:verify:hour` and re-read the beats.

**A change to `src/` can move these minutes, and did.** Two fixes landed in the
app after this hour was tuned and both shortened a trip: a bandera stopped being
charged for a drive to a passenger already aboard, which took three minutes off
Marvin's morning and collapsed Carla's time in the queue to fifty-eight seconds —
a mechanism nobody in the room would have seen work. The ✋ moved from 09:04 to
09:06 and Doña Rosa's break behind it to 09:06, which puts Carla's wait back to
three minutes. Note the ordering there: it is load-bearing and not cosmetic. A
driver mid-trip holds their screen and an idle one does not, so a break asked for
while Marvin is still idle takes *his* screen, and the 09:08 refusal then plays on
a phone that is not on the page. If you move either beat, move them together.

**Nothing in `src/` may import from `demo/`.** The dependency runs one way. `demo/`
imports `../src/domain/*`, `seeds/dev.sql` and everything in `migrations/`; that is
the whole contract.

**Every bundle goes through `bundle.mjs`, including the dev server.** Not tidiness:
`db.ts` applies the migrations as a *directory listing*, which needs an esbuild
plugin, and the esbuild CLI cannot load plugins. The demo broke exactly once this
way — it named `migrations/0001_init.sql` alone, `0002` added a column the domain
writes on every trip, and every trip in the demo threw on a page that both
typecheckers called clean. If you add a bundling step, route it through here.
Migrations must be named `NNNN_name.sql` or the build refuses, because anything
else would be applied in an order `wrangler d1 migrations apply` would not use.

**The vertical budget is tight and deliberate.** `--phone-h` is derived from a
measured constant — the top bar, the stage padding, the column heading, and per
slot the bezel, the gap and the take-control bar — so that four phones and the map
fit 1080p without the page scrolling. The log lives in the middle column
under the map, filling the height the map does not use, which is where the phones'
extra thread came from. If you add furniture down the page, that constant moves
with it, and `demo:verify:handout` is what tells you the 09:08 refusal has stopped
fitting.

**There is no scroll trick, and one was tried.** The bot answers in bursts — the
09:08 refusal is two messages, a driver coming free gets three — so the obvious
fix for a short phone is to scroll to the top of the newest burst rather than to
the bottom. It is wrong. When a burst does not fit, something is lost either way,
and top-aligning loses the *newest* message, which on a driver's phone is the
trip card carrying the ✅ Listo he is meant to tap; measured across the hour it hid
that card on two of four phones for most of the morning. The thread scrolls to its
end, the glass is made big enough, and `demo:verify:handout` measures the tallest
burst of the hour against it every sim minute.

**`prefers-reduced-motion` keeps the taxis moving.** Their speed is the data (R3),
so freezing them would delete what the page is showing rather than calm it down;
the clock button is the honest answer for anybody who wants the town to stop. What
the setting turns off is the decoration: the lift on an arriving bubble, and the
200 ms settle on a pressed control. The press *highlight* stays, because which
control was tapped is information — it degrades to an instant state change that
holds for the same 450 ms.

**A press can be scrolled off its own phone, and that is the thread's rule winning.**
The highlight goes on before the reply is rendered, so at that instant the control is
the newest thing on the glass — and when the reply is a burst (a driver's ✅ Listo is
answered with three bubbles) the thread scrolls to the newest of them and takes the
button that caused them out of frame. Top-aligning a burst instead was tried and
measured: it hid the trip card on two of four phones for most of the morning. So the
press defers, and what you see of a tap with a burst behind it is the burst.
`demo:verify:hour` asserts the press is genuinely *on the glass* for the four pictures
that claim it, and prints the overhang for the ✅ Listo rather than asserting it, so a
copy string that shortens the burst cannot turn a non-bug into a red suite.

Choices made in a list sheet are unaffected, because the sheet floats over the thread
rather than scrolling with it: a row press puts the sheet back up for its 450 ms with
the chosen row marked. That sheet is a picture and is drawn as one — no handlers on
its rows and no pointer events on it at all — since it covers the whole phone, and a
picture that could catch a tap would swallow the next half-second of them, including
the ✅ Listo a driver is being asked for.

**The press is the only real-time thing in `demo/src/`.** A tap and its reply happen
inside one drain, at one sim instant, so a highlight cannot be given a sim duration;
`press.ts` runs on a `setTimeout` and all it ever does is set an attribute and remove
it, so nothing it does can reach the trace R4 is judged on. It is also why the
harness has `__demo.clearPresses()`: whether a press is lit when a screenshot is
taken is a race nothing can win by waiting, so every picture but the four that are
*about* a press ends them first. At most one control per phone is ever lit — a new
press ends that phone's previous one — which is what makes "it must not smear at
30×" true by construction rather than by a duration tuned against think-times.

**The hour stops itself, and not at 10:00.** `main.ts` halts the clock when
`Scenario.scripted` holds *and* `trips` has nothing open. Both halves matter: a hard
cut at a clock reading would sooner or later freeze a taxi halfway to a passenger
who is still waiting. The closing tally in the log is counted out of the tables at
that instant rather than written into the last beat, so it stays true when a viewer
takes a phone and changes what happened.

There are two flags behind that and the difference is load-bearing. `finished` is the
stopped state, and taking a phone after the end *releases* it — a person can hail, and
a hail wants a clock. `ended` is the fact that this world's hour has had its ending,
and it is never released: without it the next pump would find the script still spent
and no trip open, halt again, and leave the viewer with live glass and a dead ▶.
`demo:verify:hour` steps two minutes past the release to check it holds.

**The build has two markers.** `demo/build.mjs` finds the `<link>` and the
`<script src>` in `index.html` by exact text and swaps them for the bytes they
point at. Edit either line and the build fails loudly rather than shipping a
handout that fetches two sibling files and shows nothing.

**Files.**

```
demo/
  PLAN.md                 the design, and why each decision went the way it did
  README.md               this file
  index.html              the dev shell, and the build's input
  bundle.mjs              every esbuild invocation, and the migrations plugin
  build.mjs               esbuild → dist/index.html, one self-contained file
  src/
    main.ts               wiring, the tick loop, and the hour control
    d1.ts, db.ts          a D1Database over sql.js, and a fresh seeded database
    clock.ts, rng.ts      the sim clock and the seeded PRNG (R4)
    queue.ts              the single inbound queue (R1)
    transport.ts          Transport → phone slots and the log
    town.ts, map.ts       zone polygons, the road graph, projection, sprites
    fleet.ts              drives per driver, planned from travelMinutes (R3)
    phone.ts              phone chrome and a renderer per OutboundSpec kind
    slots.ts              four slots: assignment, retention, pinning (R5)
    npc/                  reactive customer and driver NPCs
    press.ts              the control that was pressed, shown pressing
    scenario.ts           the scripted hour as beats
    ticker.ts, zonetimes.ts, style.css
  verify-phase{1,3,4,5,6}.ts
```
