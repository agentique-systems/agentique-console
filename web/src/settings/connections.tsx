import { useState } from "react";
import { CONNECTION_IDS, MODEL_EFFORTS, type ConnectionId, type ConnectionTestResult, type SettingsResponse, type SettingsSave, type SettingsValues } from "@agentique-console/core";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Group, NumberField, SelectField, TextField, ToggleField } from "./fields";

export interface EditorProps {
  values: SettingsValues; data: SettingsResponse;
  change: (path: string, value: unknown) => void;
  lock: (path: string) => string | undefined;
  secrets: NonNullable<SettingsSave["secrets"]>;
  secret: (id: string, value: string | null) => void;
  confirm: (title: string, description: string, action: () => void) => void;
  error: (message: string) => void;
  tested: () => void;
}
const labels: Record<ConnectionId, string> = { claude: "Claude Agent SDK", codex: "Codex SDK", openai: "OpenAI / compatible endpoint", anthropic: "Anthropic through AI SDK", gateway: "Vercel AI Gateway" };
export const providerLabels = [{ value: "claude", label: "Claude" }, { value: "codex", label: "Codex" }, { value: "ai-sdk", label: "AI SDK" }];
function selectedModel(id: ConnectionId, v: SettingsValues): string | undefined {
  if (id === "claude" || id === "codex") return v.providers.defaultModels[id];
  const current = v.providers.defaultModels["ai-sdk"];
  return current.replace(/^pi\//, "").startsWith(`${id}/`) ? current : v.providers.models["ai-sdk"].find((m) => m.id.replace(/^pi\//, "").startsWith(`${id}/`))?.id;
}
export function TestResult({ result }: { result: ConnectionTestResult }) {
  return <div role="status" className="space-y-1 rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
    <p className="font-semibold">{result.status === "verified" ? "Verified for this check" : result.status === "failed" ? "Check failed" : "Configured but unverified"}</p>
    <p>{result.message}</p><p className="text-muted-foreground">{result.check} · {new Date(result.checkedAt).toLocaleString()}</p>
    {result.model && <p>Model: {result.model} · {result.modelAccess.replaceAll("_", " ")}</p>}
    {result.authentication !== "not_tested" && <p>Authentication: {result.authentication.replaceAll("_", " ")}</p>}
  </div>;
}
export function ProvidersEditor(props: EditorProps) {
  const { values: v, change, lock } = props;
  const [selected, setSelected] = useState<ConnectionId>("claude");
  const [provider, setProvider] = useState<"claude" | "codex" | "ai-sdk">(v.providers.defaultProvider);
  const [modelId, setModelId] = useState("");
  const [modelIndex, setModelIndex] = useState(0);
  const model = v.providers.models[provider][modelIndex];
  return <>
    <Group title="Conversation defaults" description="Used for new conversations across this instance. Workspace overrides take precedence. Existing conversations keep their selected model.">
      <SelectField label="Default provider" value={v.providers.defaultProvider} options={providerLabels} locked={lock("providers.defaultProvider")} onChange={(value) => change("providers.defaultProvider", value)} />
      <SelectField label="Default model" value={v.providers.defaultModels[v.providers.defaultProvider]} options={v.providers.models[v.providers.defaultProvider].map((m) => ({ value: m.id, label: m.label }))} locked={lock(`providers.defaultModels.${v.providers.defaultProvider}`)} onChange={(value) => change(`providers.defaultModels.${v.providers.defaultProvider}`, value)} />
    </Group>
    <Group title="Connections" description="Configure the connection used by each adapter. API credentials stay on the server. Testing never starts a conversation or generation.">
      <SelectField label="Connection" value={selected} options={CONNECTION_IDS.map((id) => ({ value: id, label: labels[id] }))} onChange={(value) => setSelected(value as ConnectionId)} />
      <ConnectionEditor key={selected} {...props} id={selected} />
    </Group>
    <Group title="Model availability" description="A catalog is an allowlist for new conversations. Listing a model does not guarantee that your account can generate with it.">
      <SelectField label="Model adapter" value={provider} options={providerLabels} onChange={(value) => { setProvider(value as typeof provider); setModelIndex(0); }} />
      <SelectField label="Adapter default model" value={v.providers.defaultModels[provider]} options={v.providers.models[provider].map((m) => ({ value: m.id, label: m.label }))} locked={lock(`providers.defaultModels.${provider}`)} onChange={(value) => change(`providers.defaultModels.${provider}`, value)} />
      <ul className="divide-y divide-border rounded-md border border-border">{v.providers.models[provider].map((m, i) => <li key={m.id} className="flex min-w-0 items-center gap-2 px-3 py-2 text-sm"><button type="button" className="min-w-0 flex-1 break-all text-left underline-offset-4 hover:underline" onClick={() => setModelIndex(i)}>{m.label}<span className="block text-xs text-muted-foreground">{m.id}</span></button><Button type="button" size="sm" variant="ghost" disabled={!!lock(`providers.models.${provider}`) || m.id === v.providers.defaultModels[provider]} onClick={() => { change(`providers.models.${provider}`, v.providers.models[provider].filter((x) => x.id !== m.id)); setModelIndex(0); }} aria-label={`Remove model ${m.id}`}>Remove</Button></li>)}</ul>
      <TextField label="Manual model id" value={modelId} onChange={setModelId} locked={lock(`providers.models.${provider}`)} description={provider === "ai-sdk" ? "Use openai/model, anthropic/model, gateway/provider/model, or enabled pi/provider/model. Compatible OpenAI endpoints must support the Responses API." : "Use a native model id. Codex also requires support in its installed CLI catalog."} />
      <Button type="button" variant="outline" disabled={!modelId.trim() || !!lock(`providers.models.${provider}`)} onClick={() => { change(`providers.models.${provider}`, [...v.providers.models[provider], { id: modelId.trim(), label: modelId.trim(), efforts: [], contextWindowTokens: 200_000 }]); setModelId(""); }}>Add model</Button>
      {model && <details className="rounded-md border border-border p-3"><summary className="cursor-pointer text-sm font-medium">Model capabilities and accounting · {model.id}</summary><div className="mt-4 space-y-4">
        <TextField label="Model label" value={model.label} locked={lock(`providers.models.${provider}`)} onChange={(value) => change(`providers.models.${provider}.${modelIndex}.label`, value)} />
        <NumberField label="Context window (tokens)" value={model.contextWindowTokens} min={1} locked={lock(`providers.models.${provider}`)} onChange={(value) => change(`providers.models.${provider}.${modelIndex}.contextWindowTokens`, value)} description="Used to decide when continuation should start with fresh context. Confirm against your provider's model specification." />
        <fieldset className="space-y-2" disabled={!!lock(`providers.models.${provider}`)}><legend className="mb-2 text-sm font-medium">Supported reasoning effort</legend>{MODEL_EFFORTS.map((effort) => <ToggleField key={effort} label={effort} value={model.efforts.includes(effort)} onChange={(value) => change(`providers.models.${provider}.${modelIndex}.efforts`, value ? [...model.efforts, effort] : model.efforts.filter((x) => x !== effort))} />)}<p className="text-xs text-muted-foreground">Only declare efforts this adapter and model accept. Empty uses the provider's default.</p></fieldset>
        <ToggleField label="Configure model pricing" value={!!model.pricing} locked={lock(`providers.models.${provider}`)} onChange={(value) => change(`providers.models.${provider}.${modelIndex}.pricing`, value ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : undefined)} description="Optional USD per million tokens. Without prices, adapters that do not report cost show it as unknown." />
        {model.pricing && Object.entries(model.pricing).map(([key, value]) => <NumberField key={key} label={`${key} · USD / million tokens`} value={value} step={0.0001} locked={lock(`providers.models.${provider}`)} onChange={(n) => change(`providers.models.${provider}.${modelIndex}.pricing.${key}`, n)} />)}
      </div></details>}
      <ToggleField label="Enable Pi harness models" value={v.providers.piHarness} locked={lock("providers.piHarness")} onChange={(value) => change("providers.piHarness", value)} description="Adds support for pi/openai/model and pi/anthropic/model in AI SDK. Uses its packaged model registry and native endpoints; custom endpoint overrides are unsupported." />
    </Group>
    <Group title="Adapter capabilities"><div className="space-y-3">{props.data.providers.map((p) => <details key={p.id}><summary className="cursor-pointer text-sm font-medium">{p.label}</summary><dl className="mt-3 space-y-3 text-xs">{Object.entries(p.capabilities).map(([name, c]) => <div key={name}><dt className="font-medium">{name} · {c.status}</dt><dd className="mt-1 text-muted-foreground">{c.detail}</dd></div>)}</dl></details>)}</div></Group>
  </>;
}
function ConnectionEditor({ id, ...props }: EditorProps & { id: ConnectionId }) {
  const { values: v, data, change, lock, secrets, secret } = props;
  const connection = v.providers.connections[id]; const meta = data.credentials[id];
  const credential = secrets[id]?.action === "replace" ? secrets[id].value ?? "" : "";
  const model = selectedModel(id, v);
  const signature = JSON.stringify([connection, credential, secrets[id]?.action, model]);
  const [test, setTest] = useState<{ signature: string; result: ConnectionTestResult } | null>(null);
  const [testing, setTesting] = useState(false);
  const unchanged = JSON.stringify(connection) === JSON.stringify(data.values.providers.connections[id]) && !secrets[id] && model === selectedModel(id, data.values);
  const result = test?.signature === signature ? test.result : unchanged ? data.tests[id] : undefined;
  const hasCredential = credential !== "" || (meta?.present && secrets[id]?.action !== "remove");
  const authOptions = [{ value: "api_key", label: "API key" }, ...(["claude", "codex"].includes(id) ? [{ value: "local_login", label: "SDK / local login" }] : []), ...(id === "openai" ? [{ value: "none", label: "No authentication (trusted local provider)" }] : []), ...(connection.auth === "deployment" ? [{ value: "deployment", label: "Deployment authentication" }] : [])];
  const prefix = `providers.connections.${id}`;
  return <div className="space-y-5 rounded-lg border border-border bg-card p-4 sm:p-5">
    <div><h3 className="font-semibold">{labels[id]}</h3><p className="mt-1 text-xs text-muted-foreground">{!connection.enabled ? "Disabled" : result ? result.status === "verified" ? "Verified for the displayed check" : result.status === "failed" ? "Connection check failed" : "Configured but unverified" : hasCredential || connection.auth === "none" || connection.auth === "deployment" ? "Configured but unverified" : "Not configured"}</p></div>
    <ToggleField label="Enable connection" value={connection.enabled} locked={lock(`${prefix}.enabled`)} onChange={(value) => change(`${prefix}.enabled`, value)} />
    <SelectField label="Authentication method" value={connection.auth} options={authOptions} locked={lock(`${prefix}.auth`)} onChange={(value) => change(`${prefix}.auth`, value)} />
    {connection.auth === "api_key" && <>
      <TextField label="API credential" value={credential} secret onChange={(value) => secret(id, value)} locked={meta?.source === "deployment" ? "deployment secret manager" : undefined} description={meta?.present ? `Credential source: ${meta.source}. Leave blank to preserve it; enter a value to replace it.` : "Stored with authenticated encryption on the server. This field is never populated with a saved secret."} />
      {data.system.secretStorage === "unavailable" && meta?.source !== "deployment" && <p className="text-xs text-muted-foreground">Credential storage requires CONSOLE_SETTINGS_KEY to be provisioned in the service environment. See Security & data.</p>}
    </>}
    {connection.auth === "local_login" && <p className="text-sm leading-relaxed text-muted-foreground">Sign in using the installed {id === "codex" ? "Codex CLI on the server, with the dedicated home shown in System & advanced" : "Claude SDK / CLI on the server"}. The console does not collect login passwords or copy SDK session tokens. Detection alone does not validate authentication.</p>}
    {connection.auth === "deployment" && <p className="text-sm text-muted-foreground">The deployed SDK owns the cloud or gateway authentication flow. Configure its credentials in the service environment.</p>}
    <TextField label="Endpoint" value={connection.endpoint} onChange={(value) => change(`${prefix}.endpoint`, value)} locked={lock(`${prefix}.endpoint`) ?? (connection.auth === "local_login" ? "native SDK authentication" : undefined)} description="Custom origins require CONSOLE_TRUSTED_ENDPOINT_ORIGINS. Re-enter the credential when changing its host. Redirects are refused by connection checks." />
    {data.activeDependencies.some((d) => d.provider === (id === "claude" || id === "codex" ? id : "ai-sdk")) && <p className="text-xs text-muted-foreground">Active conversations depend on this connection. Stop them before disabling it or changing its endpoint or credentials.</p>}
    <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={testing || secrets[id]?.action === "remove"} onClick={async () => {
      setTesting(true); try { const result = await api("testConnection", { body: { revision: data.revision, connection: id, config: connection, ...(credential ? { credential } : {}), ...(model ? { model } : {}) } }); setTest({ signature, result }); props.tested(); } catch (error) { props.error(error instanceof Error ? error.message : "Connection check failed."); } finally { setTesting(false); }
    }}>{testing ? "Testing connection…" : "Test connection & discover models"}</Button>
      {(meta?.source === "saved" || secrets[id]?.action === "remove") && <Button type="button" variant="ghost" onClick={() => props.confirm("Remove stored credential?", "This removes the local stored credential when you save. It does not revoke the key with the provider. Active dependencies must be stopped first.", () => secret(id, null))}>{secrets[id]?.action === "remove" ? "Removal pending Save" : "Remove stored credential"}</Button>}
    </div>
    {result && <TestResult result={result} />}
    {result && result.models.length > 0 && <details><summary className="cursor-pointer text-sm">Discovered models ({result.models.length})</summary><p className="my-2 text-xs text-muted-foreground">Add a model to the catalog, then choose it as a default and test its visibility.</p><div className="max-h-64 overflow-y-auto rounded border border-border">{result.models.map((modelId) => {
      const adapter = id === "claude" || id === "codex" ? id : "ai-sdk";
      const qualified = adapter === "ai-sdk" ? `${id}/${modelId}` : modelId;
      const present = v.providers.models[adapter].some((m) => m.id === qualified);
      return <div key={modelId} className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs"><span className="min-w-0 flex-1 break-all">{modelId}</span><Button type="button" variant="ghost" size="sm" disabled={present || !!lock(`providers.models.${adapter}`)} aria-label={`Add ${qualified}`} onClick={() => change(`providers.models.${adapter}`, [...v.providers.models[adapter], { id: qualified, label: qualified, efforts: [], contextWindowTokens: 200_000 }])}>{present ? "Added" : "Add"}</Button></div>;
    })}</div></details>}
  </div>;
}
