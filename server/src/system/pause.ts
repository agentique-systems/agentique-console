/**
 * The operator's whole-system Pause — one switch for every lane in the
 * install. It composes two things the console already has: the process-wide
 * mint gate in `CapacityService` (reason `operator`, held until Resume) and,
 * for a HARD pause, one fan-out that interrupts every in-flight turn without
 * a verdict on its work: seat deliveries return to `queued` and redeliver on
 * resume with a "continue, don't restart" note; main is woken once about the
 * window. Nothing is cancelled and nothing is salvaged.
 *
 * SOFT is the same switch minus the fan-out: no new turns anywhere, running
 * ones finish. The interrupt lives in one place so the mode is a flag.
 */
import type { PauseSystemResponse, SystemPauseState } from "@agentique-console/shared";
import type { AgentSessionService } from "../agent-sessions/service.ts";
import type { CapacityService } from "../capacity/service.ts";
import type { OrchestratorRunner } from "../orchestrator/runner.ts";

export interface SystemPauseDeps {
  capacity: CapacityService;
  runner: OrchestratorRunner;
  host: AgentSessionService;
}

export class SystemPauseService {
  readonly #deps: SystemPauseDeps;

  constructor(deps: SystemPauseDeps) { this.#deps = deps; }

  state(): SystemPauseState {
    return this.#deps.capacity.snapshot();
  }

  pause(opts: { mode?: "hard" | "soft"; detail?: string } = {}): PauseSystemResponse {
    // 1. The gate closes first, so nothing minted while we interrupt slips
    //    through; idempotent, and it displaces a capacity/budget pause.
    this.#deps.capacity.pauseByOperator(opts.detail);
    // 2. Hard: cut every in-flight turn. Their work waits for the resume hook.
    const interrupted = (opts.mode ?? "hard") === "hard"
      ? { main: this.#deps.runner.interruptAllForPause("operator pause"), seats: this.#deps.host.interruptAllForPause("operator pause") }
      : { main: 0, seats: 0 };
    return { ...this.state(), interrupted };
  }

  /** Resume: the capacity service's manual resume — its hooks redeliver everything. */
  resume(): SystemPauseState {
    this.#deps.capacity.resume({ manual: true });
    return this.state();
  }
}
