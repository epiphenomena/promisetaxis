/**
 * The demo's only source of randomness: mulberry32, seeded from the URL hash.
 *
 * `Math.random()` is banned everywhere in `demo/` (R4). The reason is not purity
 * for its own sake: the NPC think-times and the trip-duration jitter in later
 * phases decide which of the scripted beats actually fire, so an unseeded run
 * would be a different demo every time — a beat that lands beautifully once
 * would be unreproducible, and a bug seen at 09:14 would be unreachable.
 *
 * mulberry32 rather than something stronger because the requirement is
 * reproducibility, not unpredictability: 32 bits of state, a handful of
 * operations, and identical output in every JS engine.
 */

/**
 * The seed a plain `demo/index.html` runs on. Arbitrary — the only property
 * that matters is that it never changes, so "open it and watch" is the same hour
 * every time. Append `#seed=123` to explore a different one.
 */
export const DEFAULT_SEED = 891_531;

export type Rng = {
  /** The seed this generator was built from, so the page can display it. */
  readonly seed: number;
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number;
  pick<T>(items: readonly T[]): T;
  /** True with probability `p`. */
  chance(p: number): boolean;
};

export function createRng(seed: number): Rng {
  // Forced to a uint32 because mulberry32's state must wrap; a float seed from
  // a hand-edited hash would otherwise degrade the sequence rather than fail.
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  const int = (n: number): number => Math.floor(next() * n);

  return {
    seed,
    next,
    int,
    range: (lo, hi) => lo + next() * (hi - lo),
    chance: (p) => next() < p,
    pick<T>(items: readonly T[]): T {
      const chosen = items[int(items.length)];
      // Only reachable with an empty list, which is a caller bug rather than a
      // run of bad luck — better loud here than an `undefined` sprite later.
      if (chosen === undefined) throw new Error("rng.pick() on an empty list");
      return chosen;
    },
  };
}

/**
 * Read the seed out of a location hash: `#seed=42` or bare `#42`.
 *
 * Anything unparseable falls back to the default rather than throwing — a
 * mistyped hash in front of an audience should still give them a demo.
 */
export function seedFromHash(hash: string): number {
  const raw = hash.replace(/^#/, "");
  const match = /(?:^|[&;])(?:seed=)?(\d+)/.exec(raw);
  if (!match?.[1]) return DEFAULT_SEED;
  const seed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(seed) ? seed : DEFAULT_SEED;
}
