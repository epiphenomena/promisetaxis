/**
 * The map: one SVG, built once, with the sprites moved on every frame.
 *
 * SVG rather than canvas because the map is structure, not decoration — the zone
 * polygons are the unit dispatch actually reasons in, they carry the labels, and
 * a zone name on this page is real text: findable with the browser's own search,
 * reachable by assistive technology, and legible at any zoom. (Which is also why
 * the map is not given `role="img"`: that would collapse the whole thing to its
 * one-line label and hide every name inside it.)
 *
 * The cost is that nothing may be rebuilt per frame: every element below is
 * created once and afterwards only its transform, opacity and a data attribute
 * change, which is what keeps a moving fleet from churning the DOM at 60 Hz.
 *
 * Colour is carried entirely by the tokens in `style.css` so that light and dark
 * are one definition, and status colour follows the palette's existing meanings —
 * jade for available, clay for working, ochre for waiting — so a taxi on the map
 * and the same driver's status pill on their phone never disagree.
 *
 * This file draws what `fleet.ts` hands it and knows nothing about trips,
 * drivers, or the clock. It is the last link in the chain R2 describes, and the
 * chain only runs one way.
 */

import type { FleetFrame, TaxiView, WaitView } from "./fleet";
import type { Gazetteer, TownZone } from "./town";
import { GATEWAYS, ROADS, VIEW, ZONES } from "./town";

const NS = "http://www.w3.org/2000/svg";

/**
 * The river. Drawn from memory of the valley rather than from data: the
 * gazetteer has one landmark on it ("El río") and no course, and a town with a
 * river through it reads as a place while an abstract partition reads as a
 * diagram. Above the zone fills, because a river crosses a neighbourhood.
 */
const RIVER =
  "M -10 432 C 90 444, 170 446, 250 436 S 340 420, 402 404 " +
  "S 500 428, 592 462 S 820 512, 1130 542";

/** Contour lines. The town is in a valley; the aldeas are up in the hills. */
const CONTOURS = [
  "M 40 118 C 180 48, 360 44, 470 92",
  "M 96 66 C 250 8, 430 8, 556 62",
  "M 560 150 C 640 96, 740 92, 830 132",
  "M 880 476 C 960 440, 1040 444, 1108 476",
];

/** Which landmarks get their name on the map, and where the name sits. */
const DOT_LABELS: Record<string, { dx: number; dy: number; anchor: "start" | "middle" | "end" }> = {
  parque_central: { dx: -10, dy: -10, anchor: "end" },
  terminal: { dx: -10, dy: 5, anchor: "end" },
  hospital: { dx: -9, dy: -9, anchor: "end" },
  mirador: { dx: -10, dy: -2, anchor: "end" },
  estadio: { dx: -10, dy: 0, anchor: "end" },
  cementerio: { dx: 9, dy: 12, anchor: "start" },
  rio: { dx: -10, dy: -2, anchor: "end" },
  gasolinera: { dx: 13, dy: 6, anchor: "start" },
  aeropuerto: { dx: 10, dy: 2, anchor: "start" },
  macaw_mountain: { dx: -12, dy: -7, anchor: "end" },
};

/** The status words. Chrome, not copy — the app never shows a driver a status. */
const STATUS_WORDS: { status: string; label: string }[] = [
  { status: "available", label: "libre" },
  { status: "assigned", label: "va por el cliente" },
  { status: "on_trip", label: "en viaje" },
  { status: "break", label: "en descanso" },
  { status: "off", label: "fuera de turno" },
];

type TaxiSprite = {
  root: SVGGElement;
  glyph: SVGGElement;
  number: SVGTextElement;
  title: SVGTitleElement;
};

type WaitSprite = { root: SVGGElement; title: SVGTitleElement };

export class TownMap {
  readonly el: HTMLElement;

  private readonly trails: SVGGElement;
  private readonly customers: SVGGElement;
  private readonly fleet: SVGGElement;

  private readonly taxiSprites = new Map<number, TaxiSprite>();
  private readonly waitSprites = new Map<number, WaitSprite>();
  private readonly trailPaths = new Map<number, SVGPathElement>();

  constructor(private readonly town: Gazetteer) {
    this.el = document.createElement("figure");
    this.el.className = "map";

    const svg = node<SVGSVGElement>("svg", {
      class: "map__svg",
      viewBox: `0 0 ${VIEW.w} ${VIEW.h}`,
      "aria-label": "Mapa de Copán Ruinas con la flota de tuktuks",
    });

    svg.append(
      this.ground(),
      this.zonesLayer(),
      this.roadsLayer(),
      this.dotsLayer(),
      this.labelsLayer(),
      this.gatewaysLayer(),
    );

    this.trails = node<SVGGElement>("g", { class: "map__trails" });
    this.customers = node<SVGGElement>("g", { class: "map__customers" });
    this.fleet = node<SVGGElement>("g", { class: "map__fleet" });
    svg.append(this.trails, this.customers, this.fleet);

    this.el.append(svg, this.legend());
  }

  /**
   * One frame. Sprites are created on first sight and removed when the fleet
   * stops reporting them, so a driver deactivated mid-demo leaves no ghost.
   */
  render(frame: FleetFrame): void {
    const liveTaxis = new Set<number>();
    for (const taxi of frame.taxis) {
      liveTaxis.add(taxi.driverId);
      this.paintTaxi(taxi);
      this.paintTrail(taxi);
    }
    for (const [id, sprite] of this.taxiSprites) {
      if (liveTaxis.has(id)) continue;
      sprite.root.remove();
      this.taxiSprites.delete(id);
      this.trailPaths.get(id)?.remove();
      this.trailPaths.delete(id);
    }

    const liveWaits = new Set<number>();
    for (const wait of frame.waiting) {
      liveWaits.add(wait.tripId);
      this.paintWait(wait);
    }
    for (const [id, sprite] of this.waitSprites) {
      if (liveWaits.has(id)) continue;
      sprite.root.remove();
      this.waitSprites.delete(id);
    }
  }

  // ── The fixed map ─────────────────────────────────────────────────────────

  private ground(): SVGGElement {
    const g = node<SVGGElement>("g", { class: "map__ground" });
    g.append(
      node("rect", { class: "map__paper", x: 0, y: 0, width: VIEW.w, height: VIEW.h, rx: 14 }),
    );
    for (const d of CONTOURS) g.append(node("path", { class: "map__contour", d }));
    g.append(node("path", { class: "map__river", d: RIVER }));
    return g;
  }

  private zonesLayer(): SVGGElement {
    const g = node<SVGGElement>("g", { class: "map__zones" });
    for (const zone of ZONES) {
      g.append(
        node("polygon", {
          class: "map__zone",
          "data-tint": zone.tint,
          points: zone.polygon.map((p) => `${round(p.x)},${round(p.y)}`).join(" "),
        }),
      );
    }
    return g;
  }

  /**
   * Roads as a dark casing under a light surface, which is how a road reads as a
   * road rather than as a line. Both passes are one path per class so the whole
   * network is six elements instead of two per segment.
   */
  private roadsLayer(): SVGGElement {
    const g = node<SVGGElement>("g", { class: "map__roads" });
    for (const cls of ["highway", "street", "track"] as const) {
      const d = ROADS.filter((r) => r.cls === cls)
        .map((r) => `M${round(r.a.x)} ${round(r.a.y)}L${round(r.b.x)} ${round(r.b.y)}`)
        .join("");
      if (!d) continue;
      g.append(node("path", { class: "map__road-edge", "data-cls": cls, d }));
      g.append(node("path", { class: "map__road", "data-cls": cls, d }));
    }
    return g;
  }

  private dotsLayer(): SVGGElement {
    const g = node<SVGGElement>("g", { class: "map__dots" });
    for (const dot of this.town.dots) {
      const mark = node("circle", { class: "map__dot", cx: round(dot.at.x), cy: round(dot.at.y), r: 3.4 });
      mark.append(titled(dot.name));
      g.append(mark);
    }
    return g;
  }

  private labelsLayer(): SVGGElement {
    const g = node<SVGGElement>("g", { class: "map__labels" });

    for (const dot of this.town.dots) {
      const place = DOT_LABELS[dot.id];
      if (!place) continue;
      g.append(
        text({
          class: "map__dot-label",
          x: dot.at.x + place.dx,
          y: dot.at.y + place.dy,
          anchor: place.anchor,
          lines: [dot.name],
          lineHeight: 15,
        }),
      );
    }

    // Zone names last so they sit over anything they have to share space with.
    for (const zone of ZONES) g.append(this.zoneLabel(zone));
    return g;
  }

  private zoneLabel(zone: TownZone): SVGTextElement {
    return text({
      class: "map__zone-label",
      x: zone.label.at.x,
      y: zone.label.at.y,
      anchor: "middle",
      lines: zone.label.lines,
      lineHeight: 21,
    });
  }

  /**
   * The border arrows.
   *
   * Everything past the frame is four places with real coordinates that cannot
   * be drawn: the Guatemalan border is 4.8 km west and Agua Caliente 5.6 km
   * north, and a projection wide enough for them leaves the town a smudge. An
   * arrow at the edge is both honest about the direction and truer to how those
   * trips feel from town — you watch the tuktuk go, and later it comes back.
   */
  private gatewaysLayer(): SVGGElement {
    const g = node<SVGGElement>("g", { class: "map__gateways" });
    for (const gateway of GATEWAYS) {
      const { gate, tip } = gateway;
      const angle = Math.atan2(tip.y - gate.y, tip.x - gate.x);
      const head = 9;
      const back = { x: tip.x - Math.cos(angle) * head, y: tip.y - Math.sin(angle) * head };
      const wing = { x: -Math.sin(angle) * head * 0.5, y: Math.cos(angle) * head * 0.5 };

      g.append(
        node("path", {
          class: "map__gate-road",
          d: `M${round(gate.x)} ${round(gate.y)}L${round(back.x)} ${round(back.y)}`,
        }),
        node("polygon", {
          class: "map__gate-head",
          points: [
            `${round(tip.x)},${round(tip.y)}`,
            `${round(back.x + wing.x)},${round(back.y + wing.y)}`,
            `${round(back.x - wing.x)},${round(back.y - wing.y)}`,
          ].join(" "),
        }),
        text({
          class: "map__gate-label",
          x: gateway.label.x,
          y: gateway.label.y,
          anchor: gateway.anchor,
          lines: gateway.lines,
          lineHeight: 17,
        }),
      );
    }
    g.append(
      node("rect", {
        class: "map__frame",
        x: 1,
        y: 1,
        width: VIEW.w - 2,
        height: VIEW.h - 2,
        rx: 14,
      }),
    );
    return g;
  }

  private legend(): HTMLElement {
    const caption = document.createElement("figcaption");
    caption.className = "legend";

    for (const { status, label } of STATUS_WORDS) {
      const item = document.createElement("span");
      item.className = "legend__item";
      item.dataset.status = status;
      const swatch = node<SVGSVGElement>("svg", { class: "legend__swatch", viewBox: "0 0 22 22" });
      swatch.append(node("circle", { class: "legend__ring", cx: 11, cy: 11, r: 8 }));
      item.append(swatch, document.createTextNode(label));
      caption.append(item);
    }

    const waiting = document.createElement("span");
    waiting.className = "legend__item legend__item--wait";
    waiting.textContent = "👤 cliente esperando";
    caption.append(waiting);

    return caption;
  }

  // ── The moving parts ──────────────────────────────────────────────────────

  private paintTaxi(taxi: TaxiView): void {
    let sprite = this.taxiSprites.get(taxi.driverId);
    if (!sprite) {
      sprite = this.buildTaxi();
      this.taxiSprites.set(taxi.driverId, sprite);
      this.fleet.append(sprite.root);
    }

    sprite.root.setAttribute("transform", `translate(${round(taxi.at.x)} ${round(taxi.at.y)})`);
    sprite.root.dataset.status = taxi.status;
    sprite.root.dataset.leg = taxi.leg ?? "";
    // Only ever 1 or -1. A tuktuk glyph rotated to a bearing reads as a crash;
    // mirrored, it reads as a tuktuk going the other way.
    sprite.glyph.setAttribute("transform", `scale(${taxi.face} 1)`);
    setOpacity(sprite.root, taxi.opacity);

    const number = taxi.tuktuk ? `#${taxi.tuktuk}` : "—";
    if (sprite.number.textContent !== number) sprite.number.textContent = number;

    const where = taxi.destLabel ? ` → ${taxi.destLabel}` : "";
    const zone = taxi.zoneId ? ` · ${this.town.zoneName(taxi.zoneId) ?? taxi.zoneId}` : "";
    const word = STATUS_WORDS.find((s) => s.status === taxi.status)?.label ?? taxi.status;
    const title = `${taxi.name} ${number} · ${word}${zone}${where}`;
    if (sprite.title.textContent !== title) sprite.title.textContent = title;
  }

  private buildTaxi(): TaxiSprite {
    const root = node<SVGGElement>("g", { class: "taxi" });
    const title = titled("");
    const glyph = node<SVGGElement>("g", { class: "taxi__glyph" });
    const mark = text({ class: "taxi__mark", x: 0, y: 6, anchor: "middle", lines: ["🛺"], lineHeight: 0 });
    glyph.append(mark);

    const badge = node<SVGGElement>("g", { class: "taxi__badge", transform: "translate(0 25)" });
    const plate = node("rect", { class: "taxi__plate", x: -15, y: -11, width: 30, height: 18, rx: 6 });
    const number = text({ class: "taxi__number", x: 0, y: 2, anchor: "middle", lines: [""], lineHeight: 0 });
    badge.append(plate, number);

    root.append(
      title,
      node("ellipse", { class: "taxi__shadow", cx: 0, cy: 11, rx: 13, ry: 4 }),
      node("circle", { class: "taxi__ring", cx: 0, cy: 0, r: 15 }),
      glyph,
      badge,
    );
    return { root, glyph, number, title };
  }

  /**
   * The ghost trail: the path this taxi is still driving.
   *
   * The reason it is here at all is that "why that driver?" is the one question
   * the dispatch rule has to answer on screen, and the approach path answers it
   * without a word — the taxi that got the job is the one with the short line.
   */
  private paintTrail(taxi: TaxiView): void {
    let path = this.trailPaths.get(taxi.driverId);
    if (!path) {
      path = node<SVGPathElement>("path", { class: "map__trail" });
      this.trailPaths.set(taxi.driverId, path);
      this.trails.append(path);
    }

    if (!taxi.trail || taxi.trail.path.length < 2) {
      path.setAttribute("d", "");
      return;
    }
    path.dataset.leg = taxi.trail.kind;
    path.setAttribute(
      "d",
      taxi.trail.path
        .map((p, i) => `${i === 0 ? "M" : "L"}${round(p.x)} ${round(p.y)}`)
        .join(""),
    );
  }

  private paintWait(wait: WaitView): void {
    let sprite = this.waitSprites.get(wait.tripId);
    if (!sprite) {
      const root = node<SVGGElement>("g", { class: "wait" });
      const title = titled("");
      // The dot is the pin's exact coordinate and the figure floats above it, so
      // the sprite can be read without hiding the place it refers to.
      root.append(
        title,
        node("circle", { class: "wait__spot", cx: 0, cy: 0, r: 3.2 }),
        node("path", { class: "wait__stem", d: "M0 -3 L0 -11" }),
        node("circle", { class: "wait__ring", cx: 0, cy: -23, r: 12 }),
        text({ class: "wait__mark", x: 0, y: -18, anchor: "middle", lines: ["👤"], lineHeight: 0 }),
      );
      sprite = { root, title };
      this.waitSprites.set(wait.tripId, sprite);
      this.customers.append(root);
    }

    sprite.root.setAttribute("transform", `translate(${round(wait.at.x)} ${round(wait.at.y)})`);
    sprite.root.dataset.state = wait.state;
    const word = wait.state === "pending" ? "esperando un tuktuk" : "su tuktuk va en camino";
    const where = wait.destLabel ? ` → ${wait.destLabel}` : "";
    const title = `Cliente · ${word}${where}`;
    if (sprite.title.textContent !== title) sprite.title.textContent = title;
  }
}

// ── SVG helpers ─────────────────────────────────────────────────────────────

function node<T extends SVGElement>(tag: string, attrs: Record<string, string | number>): T {
  const el = document.createElementNS(NS, tag) as T;
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

/** A one- or two-line label. Two lines are set as tspans, centred as a block. */
function text(opts: {
  class: string;
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  lines: string[];
  lineHeight: number;
}): SVGTextElement {
  const el = node<SVGTextElement>("text", {
    class: opts.class,
    x: round(opts.x),
    y: round(opts.y),
    "text-anchor": opts.anchor,
  });
  if (opts.lines.length === 1) {
    el.textContent = opts.lines[0]!;
    return el;
  }
  opts.lines.forEach((line, i) => {
    const span = node<SVGTSpanElement>("tspan", {
      x: round(opts.x),
      dy: i === 0 ? 0 : opts.lineHeight,
    });
    span.textContent = line;
    el.append(span);
  });
  return el;
}

function titled(label: string): SVGTitleElement {
  const el = document.createElementNS(NS, "title");
  el.textContent = label;
  return el;
}

function setOpacity(el: SVGElement, value: number): void {
  const wanted = value >= 0.999 ? "" : value.toFixed(2);
  if (el.getAttribute("opacity") !== wanted) {
    if (wanted) el.setAttribute("opacity", wanted);
    else el.removeAttribute("opacity");
  }
}

/** Half-pixel precision: enough for a 1120-wide viewBox, half the attribute text. */
function round(value: number): number {
  return Math.round(value * 2) / 2;
}
