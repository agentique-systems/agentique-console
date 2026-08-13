/**
 * FakeProgram combinators for orchestration scenarios — the idioms the e2e
 * suite hand-rolls (role discrimination, per-role turn scripts, promise-gates,
 * error streaks), extracted so scenarios read as intent.
 *
 * Role model (mirrors the runtime):
 * - MAIN: the streaming user-session lane; its spawn env carries no
 *   CONSOLE_AGENT_NAME. One program invocation per pushed input = one turn.
 * - AGENTS: seat queries; env carries CONSOLE_AGENT_NAME / CONSOLE_PATTERN_ROLE.
 * - The hub coordinator can also be recognized by its prompt append, but the
 *   env name is authoritative and works for every pattern.
 */
import type { FakeProgram } from "../../src/sdk/fake.ts";
import { errorMessage, initMessage, successMessage, toolResultMessage, toolUseMessage } from "../../src/sdk/fake.ts";
import { agentRoleOf } from "../../src/test-helpers.ts";

type Turn = FakeProgram;

/** The lane identity key a program invocation runs under. */
export function laneKeyOf(options: Parameters<FakeProgram>[0]): string {
  const identity = agentRoleOf(options);
  if (identity.agent === undefined) return "main";
  return `${identity.agentSessionId ?? "?"}:${identity.agent}`;
}

/** Route each program invocation by console agent identity. */
export function roleSwitch(routes: {
  main?: FakeProgram;
  /** Keyed by agent name (e.g. "scout") or pattern role (e.g. "stage.1"). */
  agents?: Record<string, FakeProgram>;
  /** Fallback for any agent without a specific route. */
  agent?: FakeProgram;
}): FakeProgram {
  return async function* (options, tools) {
    const identity = agentRoleOf(options);
    if (identity.agent === undefined) {
      if (routes.main) yield* routes.main(options, tools);
      else {
        yield initMessage();
        yield successMessage();
      }
      return;
    }
    const specific = routes.agents?.[identity.agent] ?? (identity.role !== undefined ? routes.agents?.[identity.role] : undefined);
    const program = specific ?? routes.agent;
    if (program) yield* program(options, tools);
    else {
      yield initMessage();
      yield successMessage();
    }
  };
}

/**
 * Sequence scripted turns: invocation N (per lane) runs script min(N, last).
 * One FakeProgram instance serves EVERY lane, so the counter is keyed by lane
 * identity — three coordinators in three sessions each get their own turn 1.
 */
export function turns(...scripts: Turn[]): FakeProgram {
  const invocations = new Map<string, number>();
  return async function* (options, tools) {
    const key = laneKeyOf(options);
    const invocation = invocations.get(key) ?? 0;
    invocations.set(key, invocation + 1);
    const script = scripts[Math.min(invocation, scripts.length - 1)];
    if (script) yield* script(options, tools);
  };
}

/** A turn that emits init + optional text-tool activity + a clean result. */
export function idleTurn(): Turn {
  return async function* () {
    yield initMessage();
    yield successMessage();
  };
}

/** A promise-gate: the program parks on `promise` until the test releases it. */
export function makeGate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * An agent turn that makes one tool call and then hangs forever mid-turn —
 * the wedged-browser primitive. The turn only ends if the console interrupts
 * the lane (fake settles it as error_during_execution/interrupted).
 */
export function hangsAfterOneCall(gate: { promise: Promise<void> }, toolName = "Read"): Turn {
  return async function* () {
    yield initMessage();
    yield toolUseMessage("hang-1", toolName, { file_path: "src/index.ts" });
    await gate.promise;
  };
}

/** An agent turn that fails `n` consecutive tool calls (error-streak fodder). */
export function errorStreak(n: number, then?: Turn): Turn {
  return async function* (options, tools) {
    yield initMessage();
    for (let i = 0; i < n; i += 1) {
      yield toolUseMessage(`err-${i}`, "Read", { file_path: `missing-${i}.ts` });
      yield toolResultMessage(`err-${i}`, "boom", true);
    }
    if (then) yield* then(options, tools);
    else yield successMessage();
  };
}

/** A turn that ends in a provider error. */
export function errorTurn(subtype = "error_during_execution"): Turn {
  return async function* () {
    yield initMessage();
    yield errorMessage(subtype);
  };
}
