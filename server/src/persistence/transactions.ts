import type Database from "better-sqlite3";

/** Compensation for an external side effect, run after the root transaction has rolled back. */
export type RollbackHook = (cause: unknown) => void;

/** Completion work for an external side effect, run once after the root transaction has committed. */
export type CommitHook = () => void;

/** A rollback hook threw; reported without replacing the transaction's canonical error. */
export interface RollbackHookFailure {
  /** Position of the hook in execution order (0 = the first hook run). */
  index: number;
  message: string;
}

/** A commit hook threw; reported without affecting the committed result. */
export interface CommitHookFailure {
  /** Position of the hook in execution order (0 = the first hook run). */
  index: number;
  message: string;
}

export interface TransactorOptions {
  /** Receives every rollback-hook failure. Defaults to a no-op; the failures are also attached to the thrown error. */
  onRollbackHookFailure?: (failure: RollbackHookFailure) => void;
  /** Receives every commit-hook failure. Defaults to a no-op; a sink that throws is ignored, so the committed result is always returned. */
  onCommitHookFailure?: (failure: CommitHookFailure) => void;
}

/**
 * Explicit, re-entrant, synchronous write transactions over one SQLite
 * connection.
 *
 * Ownership. The outermost `write` (the root) owns `BEGIN IMMEDIATE`,
 * `COMMIT`, and `ROLLBACK`. A nested `write` joins the root transaction:
 * it opens no savepoint and never commits or rolls back on its own.
 *
 * Rollback-only. Any error that escapes any nested `write` marks the root
 * transaction rollback-only, whether or not an enclosing callback catches
 * it. A rollback-only root never commits: after its callback returns it
 * rolls back and throws the first failure that marked it, which is the
 * canonical cause even when a later error is thrown by the outer callback.
 *
 * Compensation. `afterRollback` registers a hook on the root transaction
 * (from any nesting depth) to undo an external side effect, such as a
 * newly written blob. Hooks run exactly once, only when the root rolls
 * back (callback failure, rollback-only failure, or commit failure), never
 * after a successful commit, after the SQLite `ROLLBACK` has been
 * attempted and the transactor has left the transaction, in reverse
 * registration order (the most recently registered hook first, like
 * unwinding). A hook that throws does not replace the canonical error: its
 * failure is reported to `onRollbackHookFailure` and attached to the
 * thrown error as the non-enumerable `rollbackHookFailures`. Hooks are
 * cleared when the root transaction ends and cannot leak into the next.
 *
 * Completion. `afterCommit` registers a hook on the root transaction (from
 * any nesting depth) to finish an external side effect once the mutation
 * is durable, such as removing the pending marker of a newly published
 * Artifact blob. Hooks run exactly once, only after a successful `COMMIT`,
 * after the transactor has settled its bookkeeping and left the
 * transaction (a hook that opens a new `write` starts a new root), in
 * registration order; they never run after a rollback or a failed
 * `COMMIT`, whose hooks are discarded with the transaction. A hook that
 * throws is reported to `onCommitHookFailure` and the remaining hooks
 * still run; neither a failing hook nor a failing sink changes the
 * committed result, which `write` returns as if every hook had succeeded.
 */
export class Transactor {
  #depth = 0;
  #rollbackOnly: { cause: unknown } | null = null;
  #hooks: RollbackHook[] = [];
  #commitHooks: CommitHook[] = [];
  readonly #onHookFailure: (failure: RollbackHookFailure) => void;
  readonly #onCommitHookFailure: (failure: CommitHookFailure) => void;

  constructor(
    private readonly sqlite: Database.Database,
    options: TransactorOptions = {},
  ) {
    this.#onHookFailure = options.onRollbackHookFailure ?? (() => {});
    this.#onCommitHookFailure = options.onCommitHookFailure ?? (() => {});
  }

  get inTransaction(): boolean {
    return this.#depth > 0;
  }

  /** True once a nested failure has doomed the current root transaction. */
  get isRollbackOnly(): boolean {
    return this.#rollbackOnly !== null;
  }

  write<T>(work: () => T): T {
    if (this.#depth > 0) return this.#nested(work);
    return this.#root(work);
  }

  /**
   * Registers compensation for an external side effect made during the
   * current root transaction. Only valid while a write transaction is
   * active; the hook belongs to the root even when registered by a nested
   * store call.
   */
  afterRollback(hook: RollbackHook): void {
    if (this.#depth === 0) {
      throw new Error("afterRollback requires an active write transaction");
    }
    this.#hooks.push(hook);
  }

  /**
   * Registers completion work for an external side effect made during the
   * current root transaction, run only after the root has committed. Only
   * valid while a write transaction is active; the hook belongs to the root
   * even when registered by a nested store call.
   */
  afterCommit(hook: CommitHook): void {
    if (this.#depth === 0) {
      throw new Error("afterCommit requires an active write transaction");
    }
    this.#commitHooks.push(hook);
  }

  #nested<T>(work: () => T): T {
    this.#depth += 1;
    try {
      return work();
    } catch (error) {
      if (this.#rollbackOnly === null) this.#rollbackOnly = { cause: error };
      throw error;
    } finally {
      this.#depth -= 1;
    }
  }

  #root<T>(work: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    this.#depth = 1;
    this.#rollbackOnly = null;
    this.#hooks = [];
    this.#commitHooks = [];
    let result: T | undefined;
    let failure: { cause: unknown } | null = null;
    try {
      result = work();
      if (this.#rollbackOnly !== null) failure = this.#rollbackOnly;
    } catch (error) {
      failure = this.#rollbackOnly ?? { cause: error };
    }
    if (failure === null) {
      try {
        this.sqlite.exec("COMMIT");
      } catch (error) {
        failure = { cause: error };
      }
    }
    if (failure === null) {
      const committed = this.#commitHooks;
      this.#reset();
      this.#runCommitHooks(committed);
      return result as T;
    }
    try {
      this.sqlite.exec("ROLLBACK");
    } catch {
      // The connection may already have rolled back (for example after a
      // failed COMMIT); the canonical failure wins over a ROLLBACK error.
    }
    const hooks = this.#hooks;
    this.#reset();
    this.#runRollbackHooks(hooks, failure.cause);
    throw failure.cause;
  }

  #reset(): void {
    this.#depth = 0;
    this.#rollbackOnly = null;
    this.#hooks = [];
    this.#commitHooks = [];
  }

  #runCommitHooks(hooks: CommitHook[]): void {
    hooks.forEach((hook, index) => {
      try {
        hook();
      } catch (error) {
        try {
          this.#onCommitHookFailure({ index, message: error instanceof Error ? error.message : String(error) });
        } catch {
          // The diagnostic sink is best effort: its failure never replaces the committed result.
        }
      }
    });
  }

  #runRollbackHooks(hooks: RollbackHook[], cause: unknown): void {
    const failures: RollbackHookFailure[] = [];
    const ordered = [...hooks].reverse();
    ordered.forEach((hook, index) => {
      try {
        hook(cause);
      } catch (error) {
        const failure = { index, message: error instanceof Error ? error.message : String(error) };
        failures.push(failure);
        this.#onHookFailure(failure);
      }
    });
    if (failures.length > 0 && cause !== null && typeof cause === "object") {
      Object.defineProperty(cause, "rollbackHookFailures", { value: failures, enumerable: false, configurable: true });
    }
  }
}
