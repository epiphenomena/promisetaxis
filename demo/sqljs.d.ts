/**
 * sql.js ships no type declarations, so here is the slice `demo/src/d1.ts` uses.
 *
 * Kept deliberately narrow: anything missing from this declaration is something
 * the D1 shim has no business calling. `each`, `exec` and `iterateStatements`
 * are all absent on purpose — a shim that reached for them would stop matching
 * D1's one-statement-at-a-time contract.
 */
declare module "sql.js" {
  export type SqlValue = number | string | Uint8Array | null;

  export interface Statement {
    /**
     * Resets and clears bindings before binding, which is what makes a cached
     * statement safe to re-bind instead of re-preparing.
     */
    bind(values?: SqlValue[]): boolean;
    /** True while a row is available, false once the statement is done. */
    step(): boolean;
    get(): SqlValue[];
    getAsObject(): Record<string, SqlValue>;
    reset(): boolean;
    free(): boolean;
  }

  export interface Database {
    /** Accepts a multi-statement script, which `prepare` does not. */
    run(sql: string): Database;
    prepare(sql: string): Statement;
    /** sqlite3_changes() for the last statement that modified rows. */
    getRowsModified(): number;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }

  /**
   * `wasmBinary` is the only form the demo may use: on `file://` a fetch for a
   * sibling .wasm is blocked, so the bytes have to be handed over directly.
   */
  export default function initSqlJs(config?: {
    wasmBinary?: Uint8Array;
  }): Promise<SqlJsStatic>;
}
