import { createStreamStore } from "@/live/stream-kit";
import { userStreamKit } from "@/session/user-stream";

/**
 * Live user-session transcripts, keyed by `userStreamKey(sessionId)`
 * (`us:<id>`). One store instance app-wide: the router appends here, the
 * transcript view watches/hydrates here.
 */
export const useUserSessionStreamsStore = createStreamStore(userStreamKit);
