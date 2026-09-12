/** All experimental harness dependencies and lifecycle handling live behind this boundary. */
import { HarnessAgent, type HarnessAgentResumeSessionState, type HarnessAgentSession } from "@ai-sdk/harness/agent";
import { createHash } from "node:crypto";
import { createPi } from "@ai-sdk/harness-pi";
import { createJustBashSandbox } from "@ai-sdk/sandbox-just-bash";
import { isStepCount, type ToolSet, type Agent } from "ai";
import type { AdapterAttempt } from "./attempt-session.ts";
import { AGENT_INSTRUCTIONS } from "./tool-definitions.ts";

export interface HarnessContinuation { sessionId: string; state: HarnessAgentResumeSessionState; journal?: string }
export interface HarnessRun {
  stream: Awaited<ReturnType<Agent<never, ToolSet>["stream"]>>;
  stop(): Promise<HarnessContinuation>;
  destroy(): Promise<void>;
}

/** Pi runs in process, with native session/compaction support and no remote workspace synchronization. */
export async function streamPiHarness(attempt: AdapterAttempt, tools: ToolSet, model: string, auth: Record<string, string>, resume: HarnessContinuation | null): Promise<HarnessRun> {
  const harness = createPi({ auth, thinkingLevel: attempt.request.effort });
  if (!harness.supportsBuiltinToolFiltering) throw new Error("invalid request: harness cannot enforce the Attempt tool set");
  const scratch = await createJustBashSandbox({ cwd: "/work", env: { HOME: "/agentique" } }).createSession({ abortSignal: attempt.signal });
  // Pi's exported lifecycle state references its private journal in sandbox HOME.
  // Persist those bytes with the opaque payload: just-bash itself cannot reattach.
  const journalPath = (sessionId: string, state: HarnessAgentResumeSessionState): string | null => {
    const data = state.data;
    const filename = data !== null && typeof data === "object" && !Array.isArray(data) ? data.sessionFileName : undefined;
    if (filename === undefined) return null;
    if (typeof filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl?$/.test(filename)) throw new Error("invalid request: invalid Pi session journal name");
    return `/agentique/.ai-sdk/harness-pi/${createHash("sha256").update(sessionId).digest("hex")}/${filename}`;
  };
  const agent = new HarnessAgent({
    harness, model, tools, activeTools: Object.keys(tools), permissionMode: "allow-reads", skills: [],
    instructions: AGENT_INSTRUCTIONS,
    // Native file/shell tools are filtered out (or overridden by authorized host tools).
    // The virtual sandbox holds harness scratch state, never canonical workspace changes.
    stopWhen: [isStepCount(attempt.limits.maxTurns), () => attempt.ended],
  });
  let session: HarnessAgentSession | undefined;
  try {
    if (resume?.journal) {
      const target = journalPath(resume.sessionId, resume.state);
      if (!target) throw new Error("invalid request: Pi continuation journal has no filename");
      await scratch.writeBinaryFile({ path: target, content: Buffer.from(resume.journal, "base64"), abortSignal: attempt.signal });
    }
    session = await agent.createSession({ sandboxSession: scratch, abortSignal: attempt.signal, ...(resume === null ? {} : { sessionId: resume.sessionId, resumeFrom: resume.state }) });
    const owned = session;
    const stream = await agent.stream({ session, prompt: attempt.request.input.text, abortSignal: attempt.signal });
    return {
      stream,
      stop: async () => {
        const exported = await owned.stop();
        // Agentique supplies a new Attempt prompt on resume. Never replay the
        // framework's in-flight host-tool queue across that authorization boundary.
        const state: HarnessAgentResumeSessionState = { type: "resume-session", harnessId: exported.harnessId, specificationVersion: exported.specificationVersion, data: exported.data };
        try {
          const target = journalPath(owned.sessionId, state);
          const bytes = target ? await scratch.readBinaryFile({ path: target }) : undefined;
          if (target && !bytes) throw new Error("Pi session journal unavailable; next Attempt must start fresh");
          if (bytes && bytes.length > attempt.limits.continuationMaxBytes) throw new Error("Pi session journal exceeds the continuation bound");
          return { sessionId: owned.sessionId, state, ...(bytes ? { journal: Buffer.from(bytes).toString("base64") } : {}) };
        } catch (error) { attempt.diagnostics.continuation = "unavailable_fresh_next_attempt"; throw error; }
        finally { await scratch.destroy(); }
      },
      destroy: async () => { try { await owned.destroy(); } finally { await scratch.destroy(); } },
    };
  } catch (error) { await Promise.allSettled([session?.destroy(), scratch.destroy()]); throw error; }
}
