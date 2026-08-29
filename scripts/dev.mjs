/**
 * One command for development: the API server (tsx watch) and the vite dev
 * server (HMR) side by side, output prefixed, both dying together. For a plain
 * run use `npm start` — that builds the UI and serves everything from the API
 * process on one port.
 */
import { spawn } from "node:child_process";

// npm exposes the path to its JS entry point to lifecycle scripts. Invoking it
// through Node avoids spawning the npm.cmd shim, which fails with EINVAL on
// some Windows/Node combinations.
const npmExecPath = process.env.npm_execpath;
const npm = npmExecPath ? process.execPath : "npm";
const npmArgs = npmExecPath ? [npmExecPath] : [];
const targets = [
  { name: "server", color: "[36m", args: ["run", "dev", "--workspace", "server"] },
  { name: "web   ", color: "[35m", args: ["run", "dev", "--workspace", "web"] },
];

const children = targets.map(({ name, color, args }) => {
  const child = spawn(npm, [...npmArgs, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `${color}${name}[0m │ `;
  const relay = (stream, sink) => {
    let carry = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      const lines = (carry + chunk).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) sink.write(`${prefix}${line}\n`);
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`${prefix}exited (${code}) — stopping the other process`);
      stop(code ?? 1);
    }
  });
  return child;
});

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 200);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

console.log("\nAgentique Console (dev) — UI on http://localhost:5173\n");
