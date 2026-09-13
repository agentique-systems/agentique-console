import { useState } from "react";
import type { ConnectionTestResult } from "@agentique-console/core";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Group, NumberField, SelectField, TextField, ToggleField } from "./fields";
import { TestResult, type EditorProps } from "./connections";

export function IntegrationsEditor(props: EditorProps) {
  const { values, change, data, lock, secrets, secret } = props;
  const [index, setIndex] = useState(0);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ signature: string; result: ConnectionTestResult } | null>(null);
  const servers = values.integrations.servers; const server = servers[index];
  const prefix = `integrations.servers.${index}`;
  const locked = lock("integrations.servers");
  const slot = server ? `mcp:${server.name}` : "";
  const entered = secrets[slot]?.action === "replace" ? secrets[slot]?.value ?? "" : "";
  const signature = JSON.stringify([server, entered, secrets[slot]?.action]);
  const visibleResult = result?.signature === signature ? result.result : JSON.stringify(server) === JSON.stringify(data.values.integrations.servers.find((s) => s.name === server?.name)) && !secrets[slot] ? data.tests[slot] : undefined;
  async function discover(consent: boolean) {
    setTesting(true);
    try { const response = await api("testMcp", { body: { revision: data.revision, server, ...(entered ? { secret: entered } : {}), acknowledgeExecutable: consent } }); setResult({ signature, result: response }); props.tested(); }
    catch (error) { props.error(error instanceof Error ? error.message : "Discovery failed."); }
    finally { setTesting(false); }
  }
  return <>
    <Group title="MCP servers" description="Connect installed tools and remote services, including browser tooling. A connection does not grant any tool permission.">
      <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={!!locked} onClick={() => {
        let name = "server"; let n = 1; while (servers.some((s) => s.name === name)) name = `server${n++}`;
        change("integrations.servers", [...servers, { name, enabled: false, transport: "http", command: "", args: [], url: "" }]); setIndex(servers.length);
      }}>Add MCP server</Button><Button type="button" variant="outline" disabled={!!locked || servers.some((s) => s.name === "browser")} onClick={() => { change("integrations.servers", [...servers, { name: "browser", enabled: false, transport: "stdio", command: "", args: [], url: "" }]); setIndex(servers.length); }}>Configure browser tools</Button></div>
      {!server && <p className="text-sm text-muted-foreground">No MCP servers are configured. Add a remote endpoint or an already installed server.</p>}
      {server && <>
        <SelectField label="MCP server" value={String(index)} onChange={(v) => setIndex(Number(v))} options={servers.map((s, i) => ({ value: String(i), label: s.name }))} />
        <div className="space-y-5 rounded-lg border border-border bg-card p-4 sm:p-5">
          <TextField label="Server name" value={server.name} onChange={(v) => change(`${prefix}.name`, v)} locked={locked ?? (data.values.integrations.servers.some((s) => s.name === server.name) ? "stable connection identity; add a server to use another name" : undefined)} description="Agent definitions refer to this name. Browser tooling uses browser." />
          <ToggleField label="Enable server" value={server.enabled} onChange={(v) => change(`${prefix}.enabled`, v)} locked={locked} description="Makes the connection available to agents that already declare and are authorized for its tools." />
          <SelectField label="Transport" value={server.transport} onChange={(v) => change(`${prefix}.transport`, v)} locked={locked} options={[{ value: "http", label: "Streamable HTTP" }, { value: "stdio", label: "Installed executable (stdio)" }]} />
          {server.transport === "http" ? <TextField label="MCP endpoint" value={server.url} onChange={(v) => change(`${prefix}.url`, v)} locked={locked} description="The exact origin must be configured in CONSOLE_TRUSTED_ENDPOINT_ORIGINS. Redirects are refused during discovery." /> : <>
            <TextField label="Executable path" value={server.command} onChange={(v) => change(`${prefix}.command`, v)} locked={locked} description="Absolute path to an already installed executable. Starting a server runs code with the console process's OS permissions." />
            <TextField label="Arguments" value={server.args.join("\n")} onChange={(v) => change(`${prefix}.args`, v ? v.split("\n") : [])} locked={locked} multiline description="One argument per line. No shell splitting. Store secrets in the protected environment field below, never in arguments." />
          </>}
          <TextField label={server.transport === "http" ? "Protected headers" : "Protected environment"} value={entered} secret onChange={(v) => secret(slot, v)} locked={data.credentials[slot]?.source === "deployment" ? "deployment" : undefined} description='Optional JSON object of string values, for example {"Authorization":"Bearer …"}. Saved values are never displayed; blank preserves them.' />
          {data.credentials[slot]?.present && <p className="text-xs text-muted-foreground">Protected values present · {data.credentials[slot]?.source}</p>}
          <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={testing || secrets[slot]?.action === "remove"} onClick={() => server.transport === "stdio" ? props.confirm("Start MCP server for discovery?", "This starts the configured executable with your OS permissions and lists its tools. Review its path and arguments first. No tools will be called or authorized.", () => { void discover(true); }) : void discover(false)}>{testing ? "Discovering…" : "Test & discover tools"}</Button>
            {data.credentials[slot]?.source === "saved" && <Button type="button" variant="ghost" onClick={() => props.confirm("Remove protected values?", "Save to remove these local values. This does not revoke credentials upstream.", () => secret(slot, null))}>Remove protected values</Button>}
            <Button type="button" variant="ghost" disabled={!!locked} onClick={() => props.confirm("Remove MCP connection?", "This removes the connection on Save. Active conversations must be stopped first. Tool permissions will not be broadened.", () => { change("integrations.servers", servers.filter((_, i) => i !== index)); secret(slot, null); setIndex(0); })}>Remove server</Button>
          </div>
          {visibleResult && <><TestResult result={visibleResult} />{visibleResult.models.length > 0 && <details><summary className="cursor-pointer text-sm">Discovered tool names</summary><ul className="mt-2 max-h-64 overflow-y-auto text-xs">{visibleResult.models.map((name) => <li className="break-all py-1 font-mono" key={name}>{name}</li>)}</ul></details>}</>}
        </div>
      </>}
    </Group>
    <Group title="Permissions" description="MCP connectivity and authorization are separate. Agents must declare each server and exact mcp__server__tool capability. The role and workspace policies can narrow those permissions; required approvals are never bypassed."><p className="text-sm text-muted-foreground">Review agent definitions in Agents & execution. Instance restrictions live in Security & data. Browser tooling follows the same permission path as other MCP tools.</p></Group>
    <Group title="Tool timeout" description="Applies after the console restarts."><NumberField label="Tool timeout (milliseconds)" value={values.integrations.toolTimeoutMs} nullable min={1000} onChange={(v) => change("integrations.toolTimeoutMs", v)} locked={lock("integrations.toolTimeoutMs")} /></Group>
  </>;
}
