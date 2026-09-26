/**
 * Phase 6's proof: the thing that gets handed out actually works.
 *
 * Everything before this phase was checked against a page served over HTTP by a
 * node process the harness started. The deliverable is not that page. It is one
 * file on a USB stick, opened by double-clicking it, in a town where the internet
 * is not reliable — so this harness never starts a server. It builds
 * `demo/dist/index.html`, opens it as `file://`, and runs the whole hour in it with
 * Chromium's networking taken away: DNS points at nothing and the proxy is a dead
 * port on localhost. If anything on the page needed the network, it fails here.
 *
 * Six questions, in the order they would sink the handout:
 *
 *   A  does it open from `file://` at all, and does it ask for anything?
 *   B  does the whole hour run in it, identically to the served page?
 *   C  is the beat that Phase 5 could not show on screen now on screen?
 *   D  are both themes right, in all three states the page can be in?
 *   E  does it hold together from a wide desktop down to a tablet?
 *   F  keyboard and reduced motion
 *
 * C is the one worth explaining. `sendStatus` re-sends the open trip card
 * immediately after `copy.driver.finishTripFirst` refuses a mid-trip ☕ Descanso,
 * so the refusal — the only moment in the hour where the system says no — was in
 * the thread and scrolled out of frame. Phase 5's own harness says as much: its
 * `peek` checks that the text is *in* the thread, which is a different question
 * from whether anybody can read it. So the assertion here is geometric. Both
 * bubbles' rectangles have to lie inside the thread's, with nothing clipped.
 *
 * Run it with `npm run demo:verify:handout`. The CDP driver is Phase 5's, plus
 * media emulation and a request log.
 */

import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── The cast, as the scenario names it ───────────────────────────────────────

const MARVIN = "50499990002";
const WILMER = "50488880004";

/** Sim milliseconds per fixed step, and steps per sim minute. Phase 5's numbers. */
const STEP_SIM_MS = 2400;
const STEPS_PER_MINUTE = 25;
const HOUR_MINUTES = 67;

const HANDOUT = join(process.cwd(), "demo", "dist", "index.html");
const SHOTS = join(process.cwd(), "demo", "dist", "shots");

/** The page's own limestone and its after-dusk counterpart, as the browser reports them. */
const LIGHT_PAPER = "rgb(246, 240, 228)";
const DARK_PAPER = "rgb(23, 18, 14)";

let checks = 0;

type Rect = { top: number; bottom: number; left: number; right: number };

type SlotView = {
  role: "customer" | "driver";
  phone: string | null;
  label: string;
  pinned: boolean;
  retained: boolean;
  word: string;
  adoptedAt: number;
  thread: string[];
};

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const bytes = buildHandout();
  mkdirSync(SHOTS, { recursive: true });
  for (const stale of readdirSync(SHOTS)) {
    if (stale.startsWith("handout-")) rmSync(join(SHOTS, stale));
  }

  assertSelfContained();

  const browser = await Browser.launch();
  try {
    console.log("\n  ── A: it opens from file://, with the network taken away ──\n");
    const page = await browser.open(`file://${HANDOUT}#probe=1`);
    say(`the handout boots from ${`file://${HANDOUT}`.slice(0, 64)}…`);
    expect(
      "…having asked the network for nothing but the file itself",
      page.requests.join(" | "),
      `file://${HANDOUT}`,
    );
    expect(
      "…and the SQLite engine really is running in it",
      await page.eval<number>(
        "window.__demo.trace().then((t) => JSON.parse(t).drivers.length)",
      ),
      4,
    );
    await page.shot("handout-00-before-the-hour");

    console.log("\n  ── B: the whole hour, inside the one file ─────────────────\n");
    await runHour(page);

    console.log("\n  ── C: the beat that used to play off-screen ───────────────\n");
    // A second page rather than rewinding the first: the assertion is about a
    // single sim minute and the hour has to arrive at it the way a viewer does.
    const beat = await browser.open(`file://${HANDOUT}#probe=1`);
    await refusalIsLegible(beat);

    console.log("\n  ── D: light and dark, all three states ────────────────────\n");
    await themes(beat);

    console.log("\n  ── E: wide desktop down to a tablet ───────────────────────\n");
    await widths(beat);

    console.log("\n  ── F: keyboard, and a viewer who asked for less motion ────\n");
    await keyboardAndMotion(beat);

    const noise = [...page.problems, ...beat.problems];
    if (noise.length > 0) {
      throw new Error(`FAILED the browser logged ${noise.length} problem(s):\n  ${noise.join("\n  ")}`);
    }
    say("neither page logged a console error, a warning or an exception");

    const asked = [...page.requests, ...beat.requests].filter((u) => !u.startsWith("file://"));
    expect("…and neither one reached for the network at any point", asked.join(" | "), "");

    console.log(
      `\n${checks} checks passed. ` +
        `demo/dist/index.html is ${(bytes / 1024 / 1024).toFixed(2)} MB — open it by double-clicking.\n` +
        `Screenshots in demo/dist/shots/handout-*.png — look at them.\n`,
    );
  } finally {
    await browser.close();
  }
}

// ── A: what the file is ──────────────────────────────────────────────────────

function buildHandout(): number {
  execFileSync(process.execPath, [join(process.cwd(), "demo", "build.mjs")], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  const bytes = statSync(HANDOUT).size;
  say(`the handout builds: ${(bytes / 1024 / 1024).toFixed(2)} MB in one file`);
  return bytes;
}

/**
 * Nothing in the file may point at a second file.
 *
 * Read off the bytes rather than inferred from the browser, because a reference
 * the browser happens not to reach on this run — a stylesheet behind a media
 * query, an icon only the tab bar asks for — is exactly the one that would break
 * on somebody's laptop and not here.
 */
function assertSelfContained(): void {
  const html = readFileSync(HANDOUT, "utf8");
  const external = [...html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)]
    .map((m) => m[1] ?? "")
    .filter((url) => !url.startsWith("data:"));
  expect("nothing in the file refers to a second file", external.join(" | "), "");
  expect("…the stylesheet is inline", html.includes("<style>"), true);
  expect("…the script is inline and classic, so file:// has no module to fetch", /<script>\n/.test(html), true);
  // Text out of `migrations/` and `seeds/dev.sql`, which esbuild inlined as string
  // literals. If either stopped travelling with the bundle the handout would open
  // on an empty database, which looks like a broken page rather than a missing file.
  expect("…the app's real schema travelled with it", html.includes("CREATE TABLE trips"), true);
  expect("…and so did the seeded town", html.includes("barrio_arriba"), true);

  // Every migration, not just the first. This is the regression guard for the way
  // the demo actually broke: `db.ts` named `0001_init.sql` alone, so `approach_min`
  // was missing and `markDriverUnderway` threw on every trip — invisible to both
  // typecheckers and to every suite that does not open a database. Read off the
  // bytes against a directory listing, so a `0003` nobody told the demo about fails
  // here rather than in front of an audience.
  for (const name of readdirSync(join(process.cwd(), "migrations")).sort()) {
    if (!name.endsWith(".sql")) continue;
    const sql = readFileSync(join(process.cwd(), "migrations", name), "utf8");
    // The last statement of each file, which is the part a truncated inline would
    // lose, matched on its distinctive tail rather than on the whole text: esbuild
    // escapes the literal, so newlines and quotes do not survive as written.
    const tail = [...sql.matchAll(/^(?!--)\s*(\S.*?);\s*$/gm)].at(-1)?.[1];
    if (!tail) throw new Error(`FAILED migrations/${name} has no statement to look for`);
    const needle = tail.split(/\s+/).slice(0, 6).join(" ");
    expect(`…and so did migrations/${name} — “${needle}…”`, html.includes(needle), true);
  }
}

// ── B: the hour ──────────────────────────────────────────────────────────────

const SHOT_AT: Record<number, string> = {
  2: "01-shift-start",
  9: "02-break-refused-midtrip",
  13: "03-the-chain",
  24: "04-two-trips-underway",
  31: "05-free-text",
  37: "06-cancelled-while-pending",
  59: "07-zone-time-learned",
  66: "08-hour-over",
};

/**
 * The tallest burst any phone had to show, all hour, and whether the newest
 * message ever fell off the glass.
 *
 * `runH` is from the top of the newest run — the bubbles since the other party
 * last spoke — to the bottom of the newest bubble; `threadH` is the glass it has
 * to fit in. Past 1.0 the *oldest* bubble of that burst was partly out of frame,
 * which is a judgement call and not automatically a fault: a driver who has just
 * come free gets a greeting, a status and a trip card in one breath, and the trip
 * card is the one that matters. What is never acceptable is the other end, so
 * that is what is asserted and the ratio is only printed.
 */
type Burst = { who: string; at: string; runH: number; threadH: number; ratio: number };

const TALLEST_BURST = `(() => {
  let worst = null;
  const clipped = [];
  for (const slot of document.querySelectorAll('.slot')) {
    const thread = slot.querySelector('.thread');
    if (!thread) continue;
    const msgs = [...thread.querySelectorAll('.msg')];
    if (msgs.length === 0) continue;
    const heads = [...thread.querySelectorAll('.msg--head')];
    const head = heads[heads.length - 1] ?? msgs[0];
    const last = msgs[msgs.length - 1];
    const box = thread.getBoundingClientRect();
    const lastBox = last.getBoundingClientRect();
    // The thread is scrolled to its end, so the only way the newest message is
    // not wholly on screen is that the bubble on its own is taller than the glass.
    if (lastBox.top < box.top - 1 || lastBox.bottom > box.bottom + 1) {
      clipped.push(slot.dataset.phone ?? '?');
    }
    const runH = last.getBoundingClientRect().bottom - head.getBoundingClientRect().top;
    const ratio = runH / thread.clientHeight;
    if (worst === null || ratio > worst.ratio) {
      worst = {
        who: slot.dataset.phone ?? '?',
        runH: Math.round(runH),
        threadH: thread.clientHeight,
        ratio,
      };
    }
  }
  return JSON.stringify({ worst, clipped });
})()`;

async function runHour(page: Page): Promise<void> {
  await page.startHour();
  // After the press, for the reason `verify-phase5.ts` gives: a finished page has
  // its speeds disabled, and 2400 sim ms a step needs at least 9.6× to clear the
  // clock's 250 ms frame clamp.
  await page.click(`[...document.querySelectorAll('#speeds button')].find((b) => b.textContent === '12×')`);

  let tallest: Burst | null = null;
  const clipped: string[] = [];

  for (let minute = 1; minute <= HOUR_MINUTES; minute += 1) {
    await page.minutes(1);

    // Sampled every minute rather than at the beats, because the claim being made
    // is about the whole hour and not about the two exchanges somebody thought to
    // look at. One beat's margin says nothing about the beat that breaks next.
    const seen = JSON.parse(await page.eval<string>(TALLEST_BURST)) as {
      worst: Omit<Burst, "at"> | null;
      clipped: string[];
    };
    if (seen.worst && (tallest === null || seen.worst.ratio > tallest.ratio)) {
      tallest = { ...seen.worst, at: formatMinute(minute) };
    }
    for (const who of seen.clipped) clipped.push(`${who} at ${formatMinute(minute)}`);

    const name = SHOT_AT[minute];
    if (name) await page.shot(`handout-${name}`);
  }

  expect("the script has run out and nobody is mid-thought", await page.scripted(), true);
  expect("no phone ever pushed its newest message off the glass", clipped.join(" | "), "");
  // Printed, not judged. It is the headroom the two-message beats live in, and a
  // maintainer who watches it climb past 1.0 knows why a beat stopped reading.
  console.log(
    `    tallest burst of the hour: ${tallest?.runH}px of messages in ${tallest?.threadH}px of ` +
      `thread (${tallest?.who} at ${tallest?.at}) — ${((tallest?.ratio ?? 0) * 100).toFixed(0)}% of the glass`,
  );
  // The payoff of the whole hour, checked the way Phase 5 checks it: a trip that
  // sat in the list for more than a minute before a driver's ✅ Listo handed it
  // over, and a customer told about it in `copy.customer.driverOnWay`'s words.
  // Beto's slot is gone by now — his conversation ended and the slot went to
  // somebody else, which is R5 working — so the evidence is in the trace.
  const trace = JSON.parse(await page.eval<string>("window.__demo.trace()")) as {
    trips: { state: string; requested_at: number; assigned_at: number | null }[];
    outbound: { body: string | null }[];
  };
  expect(
    "…two trips waited in the list and were handed over when a driver finished",
    trace.trips.filter((t) => t.state === "done" && (t.assigned_at ?? 0) > t.requested_at + 60_000).length,
    2,
  );
  expect(
    "…and both of those customers were told, in the app's own words",
    trace.outbound.filter((m) => m.body?.includes("viene por usted ahora")).length >= 2,
    true,
  );
  expect(
    "…and the matrix learned a cell from a trip it watched",
    (await page.learned()).includes("▸"),
    true,
  );
  expect(
    "…the page never grew a horizontal scrollbar while it ran",
    await page.eval<boolean>("document.body.scrollWidth <= window.innerWidth"),
    true,
  );
  expect(
    "…nor a vertical one at 1080p, which is where it is watched from",
    await page.eval<boolean>("document.documentElement.scrollHeight <= window.innerHeight"),
    true,
  );
}

// ── C: the refusal, on screen ────────────────────────────────────────────────

/**
 * Both halves of the ☕ Descanso refusal, inside the glass.
 *
 * The check is deliberately not "the text is in the thread" — Phase 5 already
 * asserts that and it passed all the way through a build where the message was
 * invisible. What is asserted is that both rectangles lie wholly within the
 * thread's scroll box at the minute a screenshot of the beat is taken.
 */
async function refusalIsLegible(page: Page): Promise<void> {
  await page.startHour();
  await page.click(`[...document.querySelectorAll('#speeds button')].find((b) => b.textContent === '12×')`);
  await page.minutes(9);

  const refusal = await page.eval<string>(`window.__demo.copy.driver.finishTripFirst`);
  const marvin = await page.slotOf(MARVIN);
  expect(
    "the refusal reached Marvin's phone",
    marvin?.thread.some((m) => m.includes(refusal.slice(0, 24).replace(/\*/g, ""))),
    true,
  );

  const seen = await page.eval<{ thread: Rect; refusal: Rect | null; card: Rect | null }>(
    `(() => {
       const slot = document.querySelector('.slot[data-phone="${MARVIN}"]');
       const thread = slot.querySelector('.thread');
       const msgs = [...thread.querySelectorAll('.msg')];
       const box = (el) => {
         const r = el.getBoundingClientRect();
         return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
       };
       const last = msgs[msgs.length - 1] ?? null;
       const prev = msgs[msgs.length - 2] ?? null;
       return {
         thread: box(thread),
         refusal: prev ? box(prev) : null,
         card: last ? box(last) : null,
       };
     })()`,
  );

  expect("…and the trip card the refusal re-sent is the message under it", await page.eval<boolean>(
    `[...document.querySelectorAll('.slot[data-phone="${MARVIN}"] .thread .msg')].pop()` +
      `.textContent.includes('Nuevo viaje')`,
  ), true);

  expect("the refusal is wholly inside the glass", inside(seen.refusal, seen.thread), true);
  expect("…and so is the trip card, at the same time", inside(seen.card, seen.thread), true);
  // Printed rather than asserted: it is the margin a longer copy string would eat,
  // and a maintainer who watches it shrink to nothing knows why the beat broke.
  const slack = Math.round(
    (seen.thread.bottom - seen.thread.top) -
      ((seen.card?.bottom ?? 0) - (seen.refusal?.top ?? 0)),
  );
  console.log(`    the pair is ${slack}px short of filling the thread — that is the room copy can still grow into`);

  await page.shot("handout-09-the-refusal-legible");

  // The other exchange the short phones used to cut in half. Wilmer types a place
  // nobody put in the gazetteer, is told so, types a shorter one, and gets a
  // `confirmMatch` — a text bubble followed by a bubble carrying a menu button,
  // which is the same two-message shape as the refusal and the second beat that
  // has to survive on screen rather than merely be in the thread.
  await page.minutes(22);
  const wilmer = await page.slotOf(WILMER);
  expect("Wilmer's typed attempt got the 'did you mean' back", wilmer?.thread.some((m) => m.includes("¿Se refiere a este lugar?")), true);
  const typed = await page.eval<{ thread: Rect; run: Rect | null }>(
    `(() => {
       const thread = document.querySelector('.slot[data-phone="${WILMER}"] .thread');
       const msgs = [...thread.querySelectorAll('.msg')];
       const heads = [...thread.querySelectorAll('.msg--head')];
       const head = heads[heads.length - 1] ?? msgs[0];
       const last = msgs[msgs.length - 1] ?? null;
       const box = (r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
       return {
         thread: box(thread.getBoundingClientRect()),
         run: last
           ? box({
               top: head.getBoundingClientRect().top,
               bottom: last.getBoundingClientRect().bottom,
               left: head.getBoundingClientRect().left,
               right: head.getBoundingClientRect().right,
             })
           : null,
       };
     })()`,
  );
  expect("…and the whole of it is inside his glass", inside(typed.run, typed.thread), true);
  await page.shot("handout-09b-wilmer-typing");
}

/** Sim minutes past nine, as the clock face shows them. */
function formatMinute(minute: number): string {
  return `${String(9 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function inside(inner: Rect | null, outer: Rect): boolean {
  if (!inner) return false;
  // A pixel of tolerance: the bubbles are laid out on fractional coordinates and
  // the thread's padding is in rem.
  return (
    inner.top >= outer.top - 1 &&
    inner.bottom <= outer.bottom + 1 &&
    inner.left >= outer.left - 1 &&
    inner.right <= outer.right + 1
  );
}

// ── D: themes ────────────────────────────────────────────────────────────────

/**
 * Three states, because there are three and only two of them are a toggle.
 *
 * A page with no `data-theme` on it has never been told, and follows the machine.
 * A page with one has been told by somebody clicking the button, and that has to
 * win in *both* directions — the common bug is a dark override that works and a
 * light one that the media query quietly undoes.
 */
async function themes(page: Page): Promise<void> {
  await page.eval("delete document.documentElement.dataset.theme");

  await page.emulate("prefers-color-scheme", "dark");
  expect("with nothing chosen, a dark machine gets the town after dusk", await page.paper(), DARK_PAPER);
  await page.shot("handout-10-dark-by-preference");

  await page.emulate("prefers-color-scheme", "light");
  expect("…and a light machine gets limestone", await page.paper(), LIGHT_PAPER);

  await page.eval(`document.documentElement.dataset.theme = "dark"`);
  expect("choosing dark on a light machine goes dark", await page.paper(), DARK_PAPER);
  expect(
    "…and the phones go with it rather than staying a white rectangle",
    await page.eval<string>(`getComputedStyle(document.querySelector('.thread')).backgroundColor`),
    "rgb(11, 20, 26)",
  );
  await page.shot("handout-11-dark-by-choice");

  await page.emulate("prefers-color-scheme", "dark");
  await page.eval(`document.documentElement.dataset.theme = "light"`);
  expect("choosing light on a dark machine stays light", await page.paper(), LIGHT_PAPER);
  await page.shot("handout-12-light-on-a-dark-machine");

  await page.emulate("prefers-color-scheme", "light");
  await page.eval("delete document.documentElement.dataset.theme");
}

// ── E: widths ────────────────────────────────────────────────────────────────

/**
 * Down to a tablet, checked at the width either side of the breakpoint.
 *
 * 1460px is where the middle column drops under about 650px and the landmark
 * names stop being readable, so that is where the map moves above the phones.
 * Phase 4 measured it; this checks it still holds, and that nothing below it is
 * broken — chiefly that the body never scrolls sideways, which is the failure a
 * screenshot of the top-left corner will not show.
 */
async function widths(page: Page): Promise<void> {
  for (const [width, height] of [
    [2560, 1400],
    [1920, 1080],
    // Wide but short: the width says three columns, the height says the phones
    // are already at their 320px floor and the stage has to scroll. This is the
    // case the height half of the responsive rule exists for, and the only one
    // where a wide window still wants the log pinned across the foot of it.
    [1920, 800],
    [1600, 1000],
    [1470, 980],
    [1440, 980],
    [1280, 900],
    [1024, 768],
    [860, 800],
  ] as const) {
    await page.resize(width, height);
    await page.minutes(1);
    const state = await page.eval<{ sideways: boolean; stacked: boolean; ticker: string }>(
      `(() => ({
         sideways: document.body.scrollWidth > window.innerWidth + 1,
         stacked:
           document.getElementById('col-map').getBoundingClientRect().bottom <=
           document.getElementById('col-drivers').getBoundingClientRect().top + 1,
         ticker: getComputedStyle(document.querySelector('.ticker')).position,
       }))()`,
    );
    expect(`${width}×${height}: no horizontal scroll`, state.sideways, false);
    expect(`${width}×${height}: the map ${width <= 1460 ? "sits above" : "sits between"} the phones`, state.stacked, width <= 1460);
    // Under the breakpoint the page is taller than any screen by construction, so
    // the log goes back to being pinned across the foot of it. Above it, the log
    // lives in the middle column and must not be.
    expect(
      `${width}×${height}: the log is ${width <= 1460 || height <= 880 ? "pinned to the foot of the page" : "in the middle column"}`,
      state.ticker,
      width <= 1460 || height <= 880 ? "fixed" : "static",
    );
  }

  await page.resize(1440, 980);
  await page.shot("handout-13-below-the-breakpoint");
  await page.resize(1024, 768);
  await page.shot("handout-14-tablet");
  await page.resize(1920, 1080);
}

// ── F: keyboard and motion ───────────────────────────────────────────────────

async function keyboardAndMotion(page: Page): Promise<void> {
  // A real Tab, not `.focus()`: `:focus-visible` is the whole point and it only
  // matches when the browser believes a keyboard put the focus there. Where the
  // focus lands depends on what was clicked last, which is why this asserts the
  // ring rather than the identity — the claim is that keyboard focus is *visible*,
  // on whatever it reaches.
  await page.key("Tab");
  const focused = await page.eval<{ tag: string; ring: string; visible: boolean }>(
    `(() => {
       const el = document.activeElement;
       const style = getComputedStyle(el);
       return {
         tag: el.tagName,
         ring: style.outlineWidth + " " + style.outlineStyle + " " + style.outlineColor,
         visible: el.matches(":focus-visible"),
       };
     })()`,
  );
  expect("Tab reaches a control", focused.tag, "BUTTON");
  expect("…and it is focus-visible", focused.visible, true);
  expect("…wearing the accent ring, not a hairline", focused.ring, "2px solid rgb(184, 69, 42)");

  expect(
    "the buttons on a phone nobody is driving are disabled, so Tab does not stop on them",
    await page.eval<boolean>(
      `[...document.querySelectorAll('.phone[data-live="false"] .action')].every((b) => b.disabled)`,
    ),
    true,
  );
  expect(
    "…and the ones on a phone somebody has taken are not",
    await page.eval<boolean>(
      `(() => {
         document.querySelector('.slot[data-phone="${MARVIN}"] .slot__take').click();
         const live = [...document.querySelectorAll('.slot[data-phone="${MARVIN}"] .action')]
           .every((b) => !b.disabled);
         document.querySelector('.slot[data-phone="${MARVIN}"] .slot__take').click();
         return live;
       })()`,
    ),
    true,
  );

  // The taxis keep moving under reduced motion — that is the decision, and it is
  // the animation on an arriving bubble that goes.
  expect(
    "a bubble announces itself by default",
    await page.eval<string>(
      `getComputedStyle(document.querySelector('.msg[data-fresh] .msg__bubble')).animationName`,
    ),
    "msg-arrive",
  );

  // And a press, which is the other half of the motion question and the harder one:
  // the bubble's lift is decoration, so switching it off loses nothing, but *which
  // control was tapped* is information. So the highlight has to survive a viewer who
  // asked for less motion, with only the settle into it going.
  const lively = await pressMarvinsPin(page);
  expect("a press lands with a settle by default", lively.animation, "press-land");
  // Not compared to a colour: the settle animates *from* a full fill to the wash, so a
  // computed background read while it is playing is whatever frame it is on. What is
  // asserted is that it is tinted at all; the exact wash is checked below, where the
  // animation is gone and the value is the one that holds.
  expect("…and tinted rather than left alone", lively.background !== "rgba(0, 0, 0, 0)", true);

  await page.emulate("prefers-reduced-motion", "reduce");
  expect(
    "…and stops when the machine asks for less motion",
    await page.eval<string>(
      `getComputedStyle(document.querySelector('.msg[data-fresh] .msg__bubble')).animationName`,
    ),
    "none",
  );

  const calm = await pressMarvinsPin(page);
  expect("…and so does the press's settle", calm.animation, "none");
  expect(
    "…while the highlight itself stays, because it is the information and not the motion",
    calm.background,
    "rgb(214, 236, 251)",
  );
  expect(
    "…while the taxis, whose movement is the data, keep going",
    await page.eval<boolean>(
      `(() => {
         const before = document.querySelector('.taxi').getAttribute('transform');
         return window.__demo.step(25, 2400).then(() =>
           document.querySelector('.taxi').getAttribute('transform') !== before);
       })()`,
    ),
    true,
  );
  await page.emulate("prefers-reduced-motion", "no-preference");
}

/**
 * Send a pin from Marvin's phone by hand, and report what the press looks like.
 *
 * Through WhatsApp's own attachment button and the place picker behind it, rather
 * than through whatever reply buttons his thread happens to be showing at this minute
 * — the composer is on every phone at every minute, so this is the one press that can
 * be produced on demand without knowing where the hour has got to. Everything it
 * sends is an ordinary `InboundEvent` (R1); the pin is a real hail from a driver's
 * number, which the domain reads as a position fix.
 *
 * Read in a single evaluation because a press lasts 450 real milliseconds and each
 * round trip to the browser spends some of them.
 */
async function pressMarvinsPin(page: Page): Promise<{ animation: string; background: string }> {
  const slot = `.slot[data-phone="${MARVIN}"]`;
  await page.eval(`document.querySelector('${slot} .slot__take').click()`);
  await page.click(`document.querySelector('${slot} .composer__attach')`);
  await page.click(`document.querySelector('${slot} .sheet__row')`);
  await page.settle();

  const seen = await page.eval<{ animation: string; background: string }>(
    `(() => {
       const el = document.querySelector('${slot} [data-pressed]');
       if (!el) return { animation: "nothing was pressed", background: "" };
       const style = getComputedStyle(el);
       return { animation: style.animationName, background: style.backgroundColor };
     })()`,
  );

  await page.eval(`document.querySelector('${slot} .slot__take').click()`);
  return seen;
}

// ── The DevTools protocol, by hand ───────────────────────────────────────────

/**
 * Phase 5's driver, with three additions: the browser is launched with no way to
 * reach the network, every request it makes is logged, and media features can be
 * emulated. No Puppeteer, because the app's dependencies are the one thing these
 * phases may not touch.
 */
class Browser {
  private nextId = 0;
  private readonly pending = new Map<number, { ok: (value: unknown) => void; bad: (err: Error) => void }>();
  private readonly sessions = new Map<string, Page>();

  private constructor(
    private readonly ws: WebSocket,
    private readonly proc: ChildProcess,
    private readonly profile: string,
  ) {}

  static async launch(): Promise<Browser> {
    for (const stale of readdirSync(tmpdir())) {
      if (!stale.startsWith("copan-handout-chrome-")) continue;
      try {
        rmSync(join(tmpdir(), stale), { recursive: true, force: true });
      } catch {
        // A crash handler outliving the browser can write into a profile while it
        // is being deleted. Housekeeping for killed runs; not worth a red build.
      }
    }

    const profile = join(tmpdir(), `copan-handout-chrome-${process.pid}`);
    mkdirSync(profile, { recursive: true });

    const proc = spawn(
      "chromium",
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--window-size=1920,1080",
        // The whole point of this harness. Names resolve to nothing and the proxy
        // is a port nothing is listening on, so any request the page makes fails
        // rather than quietly succeeding on the machine that happens to be online.
        // `file://` is unaffected: it never goes near either.
        "--host-resolver-rules=MAP * ~NOTFOUND",
        "--proxy-server=127.0.0.1:1",
        "--disable-background-networking",
        "--disable-component-update",
        // Chromium will not open a `file://` page from a `--remote-debugging-port`
        // session without this; it has nothing to do with the demo's own security.
        "--allow-file-access-from-files",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );

    const endpoint = await waitFor(async () => {
      const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      return ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
    }, "chromium never opened a debugging port");

    const ws = new WebSocket(endpoint);
    await new Promise<void>((ok, bad) => {
      ws.addEventListener("open", () => ok(), { once: true });
      ws.addEventListener("error", () => bad(new Error("could not attach to chromium")), { once: true });
    });

    const browser = new Browser(ws, proc, profile);
    ws.addEventListener("message", (ev: MessageEvent) => browser.receive(String(ev.data)));
    return browser;
  }

  async open(url: string): Promise<Page> {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this, String(sessionId));
    this.sessions.set(String(sessionId), page);
    await page.start(url);
    return page;
  }

  async close(): Promise<void> {
    this.ws.close();
    const gone = new Promise<void>((ok) => this.proc.once("exit", () => ok()));
    this.proc.kill();
    await gone;
    rmSync(this.profile, { recursive: true, force: true });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    return new Promise((ok, bad) => {
      this.pending.set(id, { ok: ok as (value: unknown) => void, bad });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  private receive(raw: string): void {
    const msg = JSON.parse(raw) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      result?: unknown;
      error?: { message: string };
    };

    if (msg.id !== undefined) {
      const waiting = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!waiting) return;
      if (msg.error) waiting.bad(new Error(`${msg.error.message}`));
      else waiting.ok(msg.result);
      return;
    }

    if (msg.method && msg.sessionId) {
      this.sessions.get(msg.sessionId)?.event(msg.method, msg.params ?? {});
    }
  }
}

class Page {
  readonly problems: string[] = [];
  /** Every URL the page asked for. One entry, the file itself, is the check. */
  readonly requests: string[] = [];

  constructor(
    private readonly browser: Browser,
    private readonly sessionId: string,
  ) {}

  async start(url: string): Promise<void> {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Log.enable");
    await this.send("Network.enable");
    await this.resize(1920, 1080);
    await this.send("Page.navigate", { url });

    await waitFor(
      async () =>
        (await this.eval<number>("document.querySelectorAll('.slot').length")) === 4 &&
        (await this.eval<string>("typeof window.__demo")) === "object"
          ? true
          : null,
      "the handout never finished booting",
    );
    await this.settle();
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.browser.send(method, params, this.sessionId);
  }

  event(method: string, params: Record<string, unknown>): void {
    if (method === "Network.requestWillBeSent") {
      const url = (params as { request?: { url?: string } }).request?.url;
      if (url) this.requests.push(url);
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      const details = (params as { exceptionDetails?: { text?: string; exception?: { description?: string } } })
        .exceptionDetails;
      this.problems.push(`exception: ${details?.exception?.description ?? details?.text ?? "?"}`);
      return;
    }
    if (method === "Runtime.consoleAPICalled") {
      const call = params as { type?: string; args?: { value?: unknown; description?: string }[] };
      if (call.type !== "error" && call.type !== "warning" && call.type !== "assert") return;
      this.problems.push(`console.${call.type}: ${(call.args ?? []).map((a) => String(a.value ?? a.description ?? "")).join(" ")}`);
      return;
    }
    if (method === "Log.entryAdded") {
      const entry = (params as { entry?: { level?: string; text?: string } }).entry;
      if (entry?.level !== "error" && entry?.level !== "warning") return;
      this.problems.push(`log.${entry.level}: ${entry.text ?? "?"}`);
    }
  }

  async resize(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  /** One media feature at a time; the others keep whatever they were. */
  private readonly media = new Map<string, string>();

  async emulate(feature: string, value: string): Promise<void> {
    this.media.set(feature, value);
    await this.send("Emulation.setEmulatedMedia", {
      features: [...this.media].map(([name, v]) => ({ name, value: v })),
    });
  }

  async eval<T>(expression: string): Promise<T> {
    const result = (await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as unknown as {
      result: { value?: T };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    };
    if (result.exceptionDetails) {
      throw new Error(
        `evaluating ${expression.slice(0, 90)} threw ` +
          `${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "?"}`,
      );
    }
    return result.result.value as T;
  }

  async click(finder: string): Promise<void> {
    const spot = await this.eval<{ x: number; y: number } | null>(
      `(() => {
         const el = ${finder};
         if (!el) return null;
         el.scrollIntoView({ block: "center", inline: "center" });
         const r = el.getBoundingClientRect();
         if (r.width === 0 || r.height === 0) return null;
         return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
       })()`,
    );
    if (!spot) throw new Error(`FAILED nothing to click for: ${finder}`);

    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await this.send("Input.dispatchMouseEvent", {
        type,
        x: spot.x,
        y: spot.y,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
      });
    }
  }

  /** A real key, so `:focus-visible` behaves the way it does for a person. */
  async key(key: string): Promise<void> {
    for (const type of ["keyDown", "keyUp"] as const) {
      await this.send("Input.dispatchKeyEvent", {
        type,
        key,
        code: key,
        windowsVirtualKeyCode: key === "Tab" ? 9 : 0,
        nativeVirtualKeyCode: key === "Tab" ? 9 : 0,
      });
    }
  }

  /**
   * A screenshot.
   *
   * Presses are put out first, and that is what makes these pictures reproducible.
   * A press lives on a real-time timer — it has to, being an affordance of the
   * interface rather than an event in the town — so a harness that steps a whole
   * morning through in twenty seconds has no way of knowing whether one happens to
   * be lit when the shutter falls. Rather than shorten the effect until it stopped
   * appearing, the harness ends it deliberately: every picture below shows the page
   * with nothing mid-press, and the two that are *about* a press ask for it by name.
   */
  /**
   * A screenshot, with nothing left mid-press.
   *
   * A press lives on a real-time timer, so whether one is lit when the shutter falls
   * is a race the harness cannot win by waiting. Ending them first is what keeps
   * these pictures about the beat they are named after — `verify-phase5.ts` is where
   * a press is photographed on purpose.
   */
  async shot(name: string, opts: { midPress?: boolean } = {}): Promise<void> {
    if (!opts.midPress) await this.eval("window.__demo.clearPresses()");

    // Chromium rasters on its own schedule and a capture taken in the same breath
    // as a resize can come back with a stale tile — in practice the speed buttons
    // arriving as an empty box. Nothing to do with the page; everything to do with
    // the pictures being the thing a reader is asked to judge it by.
    await new Promise((ok) => setTimeout(ok, 150));
    const { data } = (await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    })) as unknown as { data: string };
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`  · demo/dist/shots/${name}.png`);
  }

  async paper(): Promise<string> {
    return this.eval<string>("getComputedStyle(document.body).backgroundColor");
  }

  async startHour(): Promise<void> {
    const before = await this.eval<number>("window.__demo.hours()");
    await this.click(`document.getElementById('hour')`);
    await waitFor(
      async () => ((await this.eval<number>("window.__demo.hours()")) > before ? true : null),
      "the hour control was pressed and no hour was built",
    );
    await this.settle();
  }

  async minutes(count: number): Promise<void> {
    await this.eval(`window.__demo.step(${STEPS_PER_MINUTE * count}, ${STEP_SIM_MS})`);
  }

  async settle(): Promise<void> {
    await this.eval("window.__demo.step(6, 0)");
  }

  async slotOf(phone: string): Promise<SlotView | null> {
    return this.eval<SlotView | null>(`window.__demo.slotOf(${JSON.stringify(phone)})`);
  }

  async ticker(): Promise<string[]> {
    return this.eval<string[]>("window.__demo.ticker()");
  }

  async learned(): Promise<string> {
    return this.eval<string>("window.__demo.learned()");
  }

  async scripted(): Promise<boolean> {
    return this.eval<boolean>("window.__demo.scripted()");
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function waitFor<T>(attempt: () => Promise<T | null>, complaint: string): Promise<T> {
  for (let tries = 0; tries < 200; tries += 1) {
    try {
      const value = await attempt();
      if (value !== null && value !== false) return value;
    } catch {
      // Not yet.
    }
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error(`FAILED ${complaint}`);
}

function expect<T>(label: string, actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`FAILED ${label}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
  checks += 1;
  console.log(`  ✓ ${label}`);
}

function say(label: string): void {
  checks += 1;
  console.log(`  ✓ ${label}`);
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
