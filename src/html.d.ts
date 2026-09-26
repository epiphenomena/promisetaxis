/** Wrangler's Text module rule turns *.html imports into strings. */
declare module "*.html" {
  const content: string;
  export default content;
}

/**
 * Vite's `?raw` suffix, used by the guard tests so they assert against the seed
 * file the pilot ships rather than a copy of it that can drift. Declared here
 * with the other ambient module rules: a file with imports of its own cannot
 * carry one, because TypeScript reads it as an augmentation instead.
 */
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
