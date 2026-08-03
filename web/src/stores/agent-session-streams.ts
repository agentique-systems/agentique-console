import { createStreamStore } from "@/live/stream-kit";
import { agentStreamKit } from "@/agents/agent-stream";

/**
 * Live agent-session transcripts, keyed by `agentStreamKey(sessionId)`
 * (`as:<id>`). One store instance app-wide: the router appends here, the
 * inspector's transcript view watches/hydrates here.
 */
export const useAgentSessionStreamsStore = createStreamStore(agentStreamKit);
