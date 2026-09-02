/**
 * The process's admission state (execution-model §14 "Server restart";
 * migration-contract §4): no execution and no application mutation that
 * admits work is accepted before startup recovery completed, and none after
 * shutdown began. `starting` → `recovering` → `ready`, or `recovering` →
 * `recovery_incomplete` when the pending-blob reconciliation left an
 * obligation unresolved (the store is not ready for new writes; the
 * operator restarts the process, which retries the reconciliation);
 * `stopping` once shutdown began. Reads are always served.
 */
import { DomainError, type AdmissionState } from "@agentique-console/core";

/** A mutation refused because the process does not admit work now; the API maps it to `unavailable` (503). */
export class AdmissionRefusedError extends DomainError {
  constructor(readonly admission: AdmissionState) {
    super("conflict", `the console does not admit work now (${admission})`, { admission });
    this.name = "AdmissionRefusedError";
  }
}

export class AdmissionGate {
  #state: AdmissionState = "starting";

  get state(): AdmissionState {
    return this.#state;
  }

  get ready(): boolean {
    return this.#state === "ready";
  }

  set(state: AdmissionState): void {
    this.#state = state;
  }

  /** Throws unless the process admits work. */
  require(): void {
    if (this.#state !== "ready") throw new AdmissionRefusedError(this.#state);
  }
}
