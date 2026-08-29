import { useEffect } from "react";
import { Bot, ShieldCheck } from "lucide-react";
import { useAgentProfile, useAgentProfiles } from "@/api/queries";
import { useTrustProfile } from "@/api/mutations";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ResizableGroup, ResizableHandle, ResizablePanel, useDefaultLayout } from "@/components/ui/resizable";
import { useScopeStore } from "@/stores/scope";
import { useUiStore } from "@/stores/ui";
import { cn } from "@/lib/utils";

export function AgentsView() {
  const workspace = useScopeStore((s) => s.selectedWorkspaceId); const profiles = useAgentProfiles(workspace);
  const selected = useUiStore((s) => s.selectedProfileId); const select = useUiStore((s) => s.selectProfile);
  useEffect(() => { if (!selected && profiles.data?.[0]) select(profiles.data[0].id); }, [profiles.data, select, selected]);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: `agentique-console.layout:${workspace}:agents` });
  return <ResizableGroup orientation="horizontal" className="h-full" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
    <ResizablePanel id="profiles" defaultSize="250px" minSize="200px" maxSize="360px" groupResizeBehavior="preserve-pixel-size"><ProfileList /></ResizablePanel><ResizableHandle />
    <ResizablePanel id="card" minSize="380px"><ProfileCard /></ResizablePanel>
  </ResizableGroup>;
}

function ProfileList() {
  const workspace = useScopeStore((s) => s.selectedWorkspaceId); const profiles = useAgentProfiles(workspace);
  const selected = useUiStore((s) => s.selectedProfileId); const select = useUiStore((s) => s.selectProfile);
  return <aside className="flex min-h-0 flex-col border-r border-border bg-sidebar"><div className="flex h-12 items-center justify-between border-b border-border px-3"><div><div className="text-xs font-semibold">Agent profiles</div><div className="text-3xs text-muted-foreground">{profiles.data?.length ?? 0} available</div></div><Badge variant="outline">Registry</Badge></div>
    <div className="min-h-0 flex-1 overflow-y-auto p-1.5">{profiles.data?.map((profile) => <button key={profile.id} className={cn("mb-1 flex w-full items-start gap-2 rounded-md px-2.5 py-2.5 text-left transition-colors hover:bg-accent", selected === profile.id && "bg-accent text-accent-foreground")} onClick={() => select(profile.id)}><Bot className="mt-0.5 size-3.5" /><span className="min-w-0 flex-1"><span className="block truncate text-xs">{profile.title}</span><span className="block truncate text-3xs text-muted-foreground">{profile.source} · {profile.trusted ? "trusted" : "not trusted"}</span></span>{!profile.valid && <span className="size-1.5 rounded-full bg-status-failed" />}</button>)}</div></aside>;
}

function ProfileCard() {
  const workspace = useScopeStore((s) => s.selectedWorkspaceId); const id = useUiStore((s) => s.selectedProfileId); const profile = useAgentProfile(workspace, id); const trust = useTrustProfile();
  if (!profile.data || !workspace) return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Select a profile.</div>;
  const p = profile.data; return <aside className="h-full min-h-0 overflow-y-auto bg-background p-6"><div className="mx-auto max-w-4xl"><div className="flex items-start gap-4 rounded-xl border bg-card p-5 shadow-sm"><div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground"><Bot className="size-5" /></div><div className="min-w-0 flex-1"><h2 className="text-lg font-semibold tracking-tight">{p.title}</h2><p className="mt-1 text-sm leading-relaxed text-muted-foreground">{p.purpose}</p></div><Badge variant="outline">{p.source}</Badge></div>
    {p.source !== "builtin" && <div className="mt-3 flex flex-wrap items-center gap-2">
      <Badge variant="outline" className={cn(p.claudeValid ? "text-status-completed" : "text-status-failed")}>{p.claudeValid ? "Claude-valid" : "not Claude-valid"}</Badge>
      <Badge variant="outline" className={cn(p.agentiqueCompatible ? "text-status-completed" : "text-status-waiting")}>{p.agentiqueCompatible ? "compatible" : "incompatible"}</Badge>
      {!p.trusted ? <Button size="sm" disabled={!p.valid || !p.agentiqueCompatible || trust.isPending} onClick={() => trust.mutate({ workspaceId: workspace, profileId: p.id, revision: p.revision })}><ShieldCheck className="size-3" />Enable revision</Button> : <Badge className="gap-1"><ShieldCheck className="size-3" />trusted</Badge>}
    </div>}
    {p.incompatibilityReasons.length > 0 && <Section title="Not runnable by Agentique">{p.incompatibilityReasons.map((reason, i) => <p key={i} className="text-2xs text-status-waiting">{reason}</p>)}</Section>}
    <Section title="Prompt"><pre className="whitespace-pre-wrap font-sans text-2xs text-muted-foreground">{p.instructions}</pre></Section>
    <Section title="Runtime"><div className="flex flex-wrap gap-1">{[p.permissionMode, p.model ?? "default model", p.effort ?? "default effort", `${p.maxTurns} turns`, ...Object.keys(p.mcpServers ?? {}).map((n) => `mcp: ${n}`)].map((x) => <Badge key={x} variant="outline">{x}</Badge>)}</div></Section>
    <Section title={`Tools · ${p.tools.length}`}><div className="flex flex-wrap gap-1">{p.tools.map((tool) => <Badge key={tool} variant="secondary">{tool}</Badge>)}</div></Section>
    <Section title={`Skills · ${p.skills.length}`}><div className="text-2xs text-muted-foreground">{p.skills.join(", ") || "none"}</div></Section>
    <Section title={`Components · ${p.components.length}`}>{p.components.map((c) => <div key={c.path} className="border-b border-border/50 py-1.5 text-2xs"><span className="font-mono">{c.kind}</span> · {c.path}{!c.supported && <span className="ml-1 text-status-waiting">visible only</span>}</div>)}</Section>
    {p.files.length > 0 && <Section title={`Bundle files · ${p.files.length}`}>{p.files.map((file) => <details key={file.path} className="border-b border-border/50 py-1.5 text-2xs"><summary className="cursor-pointer font-mono">{file.path}</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-card p-2 font-mono text-3xs text-muted-foreground">{file.content}</pre></details>)}</Section>}
    {p.issues.length > 0 && <Section title="Validation">{p.issues.map((issue, i) => <p key={i} className={cn("text-2xs", issue.level === "error" ? "text-status-failed" : "text-status-waiting")}>{issue.path}: {issue.message}</p>)}</Section>}
    <p className="mt-4 break-all font-mono text-3xs text-muted-foreground">revision {p.revision}</p>
  </div></aside>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) { return <section className="mt-5"><h3 className="mb-2 text-3xs uppercase tracking-wider text-muted-foreground">{title}</h3>{children}</section>; }
