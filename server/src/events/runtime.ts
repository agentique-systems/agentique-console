import type {
  AgentRuntimeState,
  EventScope,
} from "@agentique-console/shared";
import type { EventBus } from "./bus.ts";

/**
 * Persists agent.state transitions, deduping consecutive identical states so
 * the authoritative trace stays compact. `note()` carries
 * provider liveness (retries, rate limits, tool ticks) under the current
 * state; any real state change clears it, since a stale note reads as truth.
 */
export class RuntimeBroadcaster {
  readonly #bus: EventBus;
  readonly #scope: EventScope;
  readonly #participant: string;
  readonly #ids: { userSessionId?: string; agentSessionId?: string };
  #state: AgentRuntimeState = "idle";
  #toolName: string | undefined;
  #detail: string | undefined;

  constructor(
    bus: EventBus,
    scope: EventScope,
    participant: string,
    ids: { userSessionId?: string; agentSessionId?: string },
  ) {
    this.#bus = bus;
    this.#scope = scope;
    this.#participant = participant;
    this.#ids = ids;
  }

  set(state: AgentRuntimeState, toolName?: string): void {
    if (
      state === this.#state &&
      toolName === this.#toolName &&
      this.#detail === undefined
    ) {
      return;
    }
    this.#state = state;
    this.#toolName = toolName;
    this.#detail = undefined;
    this.#emit();
  }

  /** Provider liveness under the current state (retry, rate limit, tool tick). */
  note(detail: string): void {
    if (detail === this.#detail) return;
    this.#detail = detail;
    this.#emit();
  }

  idle(): void {
    this.set("idle");
  }

  #emit(): void {
    this.#bus.append({
      type: "agent.state",
      ...this.#ids,
      payload: {
        scope: this.#scope,
        participant: this.#participant,
        state: this.#state,
        ...(this.#toolName === undefined ? {} : { toolName: this.#toolName }),
        ...(this.#detail === undefined ? {} : { detail: this.#detail }),
      },
    });
  }
}
