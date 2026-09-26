/**
 * Vitest picks this up before any test file. Nothing to do at the moment —
 * schema and seed are applied per-test in `setupDb()` so each test can vary
 * the fixture — but the hook exists so shared setup has an obvious home.
 */
export {};
