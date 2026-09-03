import { IllegalTransitionError } from "./errors.ts";

/**
 * A closed state machine: every state maps to the set of states it may move
 * to. A state that maps to an empty set is terminal.
 */
export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export interface StateMachine<S extends string> {
  readonly subject: string;
  readonly states: readonly S[];
  readonly table: TransitionTable<S>;
  readonly terminal: ReadonlySet<S>;
  canTransition(from: S, to: S): boolean;
  isTerminal(state: S): boolean;
  /** Throws `IllegalTransitionError` and returns nothing; never mutates. */
  assertTransition(from: S, to: S, details?: Record<string, unknown>): void;
}

export function defineStateMachine<S extends string>(
  subject: string,
  states: readonly S[],
  table: TransitionTable<S>,
): StateMachine<S> {
  for (const state of states) {
    const targets = table[state];
    if (!targets) throw new Error(`${subject}: transition table has no entry for ${state}`);
    for (const target of targets) {
      if (!states.includes(target)) {
        throw new Error(`${subject}: transition ${state} -> ${target} names an unknown state`);
      }
    }
  }
  const terminal = new Set(states.filter((state) => table[state].length === 0));
  return {
    subject,
    states,
    table,
    terminal,
    canTransition: (from, to) => table[from]?.includes(to) ?? false,
    isTerminal: (state) => terminal.has(state),
    assertTransition(from, to, details) {
      if (!(table[from]?.includes(to) ?? false)) {
        throw new IllegalTransitionError(subject, from, to, details);
      }
    },
  };
}
