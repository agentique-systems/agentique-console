import type {
  AgentRuntimeState,
  EventScope,
} from "@agentique-console/shared";
import type { EventBus } from "./bus.ts";

/**
 * Broadcasts transient agent.state frames, deduping consecutive identical
 * states so the wire stays quiet while a state holds.
 */
export class RuntimeBroadcaster {
  readonly #bus: EventBus;
  readonly #scope: EventScope;
  readonly #participant: string;
  readonly #ids: { userSessionId?: string; agentSessionId?: string };
  #state: AgentRuntimeState = "idle";
  #toolName: string | undefined;

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
    if (state === this.#state && toolName === this.#toolName) return;
    this.#state = state;
    this.#toolName = toolName;
    this.#bus.broadcast({
      type: "agent.state",
      ...this.#ids,
      payload: {
        scope: this.#scope,
        participant: this.#participant,
        state,
        ...(toolName === undefined ? {} : { toolName }),
      },
    });
  }

  idle(): void {
    this.set("idle");
  }
}
