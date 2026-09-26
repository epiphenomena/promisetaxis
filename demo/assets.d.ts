/**
 * The two non-code things `main.ts` imports.
 *
 * `*.css` resolves to nothing at runtime — esbuild pulls the stylesheet out into
 * a sibling `.css` file and drops the import — so the declaration exists only to
 * stop `tsc` from calling the import an error.
 *
 * `*.wasm` is base64 rather than a URL, because a URL would mean a fetch, and on
 * `file://` a fetch for a sibling `.wasm` is blocked. See `base64ToBytes` in
 * `main.ts`; the loader is configured in the `demo:dev` and `demo:build` scripts.
 */

declare module "*.css";

declare module "*.wasm" {
  const base64: string;
  export default base64;
}
