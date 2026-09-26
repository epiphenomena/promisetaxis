/**
 * esbuild's text loader turns *.sql imports into strings, which is how the demo
 * gets the real `migrations/` and `seeds/` files instead of a copy that rots.
 */
declare module "*.sql" {
  const content: string;
  export default content;
}

/**
 * Not a file: `demo/bundle.mjs` reads `migrations/` at bundle time and generates
 * this module, so a migration added to the app is applied by the demo without
 * anybody editing a list. `db.ts` explains why that has to be automatic.
 */
declare module "virtual:migrations" {
  export const MIGRATIONS: readonly { name: string; sql: string }[];
}
