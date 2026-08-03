import { create } from "zustand";

export type ConnectionStatus = "connecting" | "open" | "closed";

interface ConnectionState {
  readonly status: ConnectionStatus;
  /** Highest persisted global seq seen — the explicit-fromSeq resume cursor. */
  readonly lastSeq: number;
  readonly reconnects: number;
  setStatus(status: ConnectionStatus): void;
  noteSeq(seq: number): void;
  noteReconnect(): void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: "connecting",
  lastSeq: 0,
  reconnects: 0,
  setStatus: (status) => set({ status }),
  noteSeq: (seq) =>
    set((state) => (seq > state.lastSeq ? { lastSeq: seq } : state)),
  noteReconnect: () => set((state) => ({ reconnects: state.reconnects + 1 })),
}));
