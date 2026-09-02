import { create } from "zustand";
import type { EventStreamFrame } from "@agentique-console/core";

type OutputFrame = Extract<EventStreamFrame, { kind: "output" }>;

/** Transient provider output per Attempt: bounded, never persisted, cleared on reconnect. It is display only. */
interface OutputState {
  readonly byAttempt: Readonly<Record<string, { invocationId: string; runId: string; chunks: { kind: "text" | "tool_call"; text: string }[] }>>;
  append(frame: OutputFrame): void;
  clear(): void;
}

const MAX_CHUNKS_PER_ATTEMPT = 200;
const MAX_ATTEMPTS = 50;

export const useOutputStore = create<OutputState>((set) => ({
  byAttempt: {},
  append: (frame) =>
    set((state) => {
      const current = state.byAttempt[frame.attemptId] ?? { invocationId: frame.invocationId, runId: frame.runId, chunks: [] };
      const chunks = [...current.chunks, frame.chunk].slice(-MAX_CHUNKS_PER_ATTEMPT);
      const entries = Object.entries(state.byAttempt).filter(([id]) => id !== frame.attemptId).slice(-(MAX_ATTEMPTS - 1));
      return { byAttempt: Object.fromEntries([...entries, [frame.attemptId, { ...current, chunks }]]) };
    }),
  clear: () => set({ byAttempt: {} }),
}));
