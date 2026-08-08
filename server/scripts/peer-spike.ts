/**
 * Step-0 validation harness for the native-adoption branch.
 *
 * Proves, against the real SDK/CLI (0.3.226 / CC 2.1.226), the two
 * load-bearing assumptions of the peer-messaging architecture:
 *
 *   1. An sdk-ts session registers under CLAUDE_CODE_SESSION_NAME, appears in
 *      another sdk-ts session's ListAgents, and a native SendMessage from one
 *      arrives in the other as a user message with origin.kind === "peer".
 *   2. A PreToolUse hook on SendMessage governs the send: it can deny with a
 *      reason the model sees, and rewrite the payload via updatedInput so the
 *      receiver gets the middleware-normalized body.
 *
 * Run: npx tsx scripts/peer-spike.ts   (needs a logged-in claude CLI)
 * Exit code 0 = all checks pass.
 *
 * Validated findings (2026-08-08, SDK 0.3.226 / CC 2.1.226):
 * - sdk-ts sessions register under CLAUDE_CODE_SESSION_NAME and are listed.
 * - First cross-session contact demands ref confirmation: the send fails with
 *   `'name' is not an agent in this conversation. Re-send with the ref …` and
 *   succeeds as `to: "name [ref]"`. Middleware dedupe must treat the failed
 *   first attempt as retryable, never as a duplicate.
 * - Sender-side success is authoritative: `{"success":true, "msg_id": …}`.
 * - Inbound delivery wakes an idle streaming session and mints a turn, but the
 *   peer message does NOT surface as a `user` SDKMessage with origin.kind
 *   "peer" — the stream shows `command_lifecycle` frames around the injected
 *   turn. Receive-side observation must therefore key on sender PostToolUse
 *   success + the receiver's next turn, not on stream-parsing the envelope.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../src/async-queue.ts";

const nonce = Math.random().toString(36).slice(2, 8);
const RECV = `spike-recv-${nonce}`;
const SEND = `spike-send-${nonce}`;
const PING = `ping-${nonce}`;
const REWRITE_SUFFIX = " [SPIKE-REWRITTEN]";
const DENY_REASON = "spike-deny-test: denied once by middleware; call SendMessage again with the same input";
const TIMEOUT_MS = 180_000;

/** Mirror of the console's env hygiene: sever the launching CC session, then name ours. */
function spikeEnv(sessionName: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "CLAUDECODE" || key === "CLAUDE_PID" || key === "AI_AGENT") continue;
    if (key.startsWith("CLAUDE_CODE_") || key.startsWith("CLAUDE_BG_") || key.startsWith("CLAUDE_BRIDGE_")) continue;
    env[key] = value;
  }
  env.CLAUDE_CODE_SESSION_NAME = sessionName;
  return env;
}

function userMsg(text: string) {
  return {
    type: "user" as const,
    message: { role: "user" as const, content: [{ type: "text" as const, text }] },
    parent_tool_use_id: null,
  };
}

const checks = new Map<string, boolean>([
  ["receiver registered (init seen)", false],
  ["sender ListAgents saw receiver by name", false],
  ["PreToolUse deny reached the model", false],
  ["PreToolUse allow with updatedInput", false],
  ["native send succeeded (msg_id)", false],
  ["receiver woke and echoed the rewritten payload", false],
]);
const pass = (name: string) => {
  if (checks.get(name) === false) console.log(`  ✔ ${name}`);
  checks.set(name, true);
};

async function main(): Promise<void> {
  const abortAll = new AbortController();
  const timer = setTimeout(() => abortAll.abort(), TIMEOUT_MS);

  // ---- Receiver: persistent streaming session, parked idle after one turn.
  const recvInput = new AsyncQueue<ReturnType<typeof userMsg>>();
  recvInput.push(userMsg(
    "You are a message receiver in an infrastructure test. Reply with the single word READY, then wait. " +
    "If any further message reaches you, reply by repeating that message's exact text.",
  ));
  const recv = query({
    prompt: recvInput as AsyncIterable<never>,
    options: {
      model: "claude-haiku-4-5-20251001",
      allowedTools: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settings: { crossSessionInbound: "accept" },
      settingSources: [],
      persistSession: false,
      env: spikeEnv(RECV),
      abortController: abortAll,
    },
  });

  let recvReady!: () => void;
  const receiverReady = new Promise<void>((resolve) => { recvReady = resolve; });
  const recvPump = (async () => {
    for await (const message of recv) {
      const subtype = (message as { subtype?: string }).subtype;
      const preview = JSON.stringify(message).slice(0, 300);
      console.log(`  [recv] ${message.type}${subtype ? `/${subtype}` : ""}: ${preview}`);
      if (message.type === "system" && subtype === "init") {
        pass("receiver registered (init seen)");
      }
      if (message.type === "result") recvReady();
      if (message.type === "assistant" || message.type === "user") {
        const text = JSON.stringify((message as { message?: unknown }).message ?? "");
        if (text.includes(PING) && text.includes("SPIKE-REWRITTEN")) {
          pass("receiver woke and echoed the rewritten payload");
        }
      }
    }
  })().catch((error) => { if (!abortAll.signal.aborted) throw error; });

  await receiverReady;
  console.log(`receiver ${RECV} is up and idle; starting sender ${SEND}`);

  // ---- Sender: one-shot session with the middleware-shaped PreToolUse hook.
  let sendMessageCalls = 0;
  const send = query({
    prompt:
      `This is an infrastructure test. Do exactly this, in order:\n` +
      `1. Call ListAgents. State whether a session named "${RECV}" appears in the listing.\n` +
      `2. Call SendMessage with to="${RECV}", summary="spike ping", message="${PING} hello from spike".\n` +
      `3. If a call is denied by policy, retry once with exactly the same input.\n` +
      `4. If a tool result asks you to re-send with a ref, re-send using the exact "name [ref]" form it shows, same message.\n` +
      `5. Keep going until the send reports success or you have made 5 SendMessage attempts. Report each tool result verbatim, then stop.`,
    options: {
      model: "claude-haiku-4-5-20251001",
      allowedTools: ["SendMessage", "ListAgents"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      persistSession: false,
      env: spikeEnv(SEND),
      abortController: abortAll,
      hooks: {
        PreToolUse: [{
          matcher: "SendMessage",
          hooks: [async (input: unknown) => {
            const toolInput = (input as { tool_input?: Record<string, unknown> }).tool_input ?? {};
            sendMessageCalls += 1;
            if (sendMessageCalls === 1) {
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: DENY_REASON,
                },
              };
            }
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "allow" as const,
                updatedInput: { ...toolInput, message: `${String(toolInput.message ?? "")}${REWRITE_SUFFIX}` },
              },
            };
          }],
        }],
      },
    },
  });

  for await (const message of send) {
    if (message.type === "assistant" || message.type === "user") {
      const text = JSON.stringify((message as { message?: unknown }).message ?? "");
      if (text.includes("tool_result")) console.log(`  [send] tool_result: ${text.slice(0, 400)}`);
      if (text.includes("\\\"success\\\":true") && text.includes("msg_id")) pass("native send succeeded (msg_id)");
      if (text.includes(RECV) && (text.includes("ListAgents") || text.includes("[ref") || /appears|listed|found/i.test(text))) {
        pass("sender ListAgents saw receiver by name");
      }
      if (text.includes("spike-deny-test")) pass("PreToolUse deny reached the model");
    }
    if (message.type === "result") break;
  }
  if (sendMessageCalls >= 2) pass("PreToolUse allow with updatedInput");

  // Give the receiver a moment to drain its inbox, then shut down.
  const settle = Date.now() + 20_000;
  while (Date.now() < settle && !checks.get("receiver woke and echoed the rewritten payload")) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  recvInput.close();
  abortAll.abort();
  clearTimeout(timer);
  await recvPump.catch(() => undefined);

  console.log("\n=== peer-spike results ===");
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(` ${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) failed += 1;
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => { console.error("peer-spike crashed:", error); process.exit(2); });
