import { useEffect, useRef } from "react";
import { Bot, Copy, Plus, ShieldCheck } from "lucide-react";
import { useAgentProfile, useAgentProfiles, useManagerSession, useManagerSessions, useUserSession } from "@/api/queries";
import { useCreateManagerSession, useTrustProfile } from "@/api/mutations";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ResizableGroup, ResizableHandle, ResizablePanel, useDefaultLayout } from "@/components/ui/resizable";
import { useScopeStore } from "@/stores/scope";
import { useUiStore } from "@/stores/ui";
import { cn } from "@/lib/utils";
import { UserTranscript } from "@/session/user-transcript";
import { Composer, type ComposerHandle } from "@/session/composer";
import { foldBusy } from "@/session/user-fold";
import { useUserSessionStreamsStore } from "@/stores/user-session-streams";
import { userStreamKey } from "@/live/watched";

export function AgentsView() {
  const workspace = useScopeStore((s) => s.selectedWorkspaceId); const profiles = useAgentProfiles(workspace);
  const selected = useUiStore((s) => s.selectedProfileId); const select = useUiStore((s) => s.selectProfile);
  useEffect(() => { if (!selected && profiles.data?.[0]) select(profiles.data[0].id); }, [profiles.data, select, selected]);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: `agentique-console.layout:${workspace}:agents` });
  return <ResizableGroup orientation="horizontal" className="h-full" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
    <ResizablePanel id="profiles" defaultSize="250px" minSize="200px" maxSize="360px" groupResizeBehavior="preserve-pixel-size"><ProfileList /></ResizablePanel><ResizableHandle />
    <ResizablePanel id="manager" minSize="380px"><ManagerConversation /></ResizablePanel><ResizableHandle />
    <ResizablePanel id="card" defaultSize="380px" minSize="300px" maxSize="520px" groupResizeBehavior="preserve-pixel-size"><ProfileCard /></ResizablePanel>
  </ResizableGroup>;
}

function ProfileList() {
  const workspace = useScopeStore((s) => s.selectedWorkspaceId); const profiles = useAgentProfiles(workspace); const sessions = useManagerSessions(workspace);
  const selected = useUiStore((s) => s.selectedProfileId); const select = useUiStore((s) => s.selectProfile); const selectManager = useUiStore((s) => s.selectManagerSession); const activeManager = useUiStore((s) => s.activeManagerSessionId); const create = useCreateManagerSession();
  const open = async (id: string) => { select(id); if (!workspace) return; const existing = sessions.data?.find((s) => s.profileKey === id); const manager = existing ?? await create.mutateAsync({ workspaceId: workspace, profileId: id }); selectManager(manager.id); };
  useEffect(() => { if (selected && workspace && sessions.data && !activeManager && !create.isPending) void open(selected); }, [activeManager, selected, sessions.data, workspace]);
  return <aside className="flex min-h-0 flex-col border-r border-border bg-sidebar"><div className="flex h-9 items-center justify-between border-b border-border px-3"><span className="text-3xs uppercase tracking-wider text-muted-foreground">Agent profiles</span><Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-2xs" onClick={async () => { if (!workspace) return; const session = await create.mutateAsync({ workspaceId: workspace }); select(session.profileKey); selectManager(session.id); }}><Plus className="size-3" />new</Button></div>
    <div className="min-h-0 flex-1 overflow-y-auto">{profiles.data?.map((profile) => <button key={profile.id} className={cn("flex w-full items-start gap-2 border-b border-border/50 px-3 py-2 text-left hover:bg-accent", selected === profile.id && "bg-accent")} onClick={() => void open(profile.id)}><Bot className="mt-0.5 size-3.5" /><span className="min-w-0 flex-1"><span className="block truncate text-xs">{profile.title}</span><span className="block truncate text-3xs text-muted-foreground">{profile.source} · {profile.trusted ? "trusted" : "not trusted"}</span></span>{!profile.valid && <span className="size-1.5 rounded-full bg-status-failed" />}</button>)}</div></aside>;
}

function ManagerConversation() {
  const managerId = useUiStore((s) => s.activeManagerSessionId); const selected = useUiStore((s) => s.selectedProfileId); const select = useUiStore((s) => s.selectProfile);
  const detail = useManagerSession(managerId); const user = useUserSession(managerId); const composerRef = useRef<ComposerHandle>(null);
  const manager = detail.data?.session; const busy = useUserSessionStreamsStore((s) => managerId ? foldBusy(s.streams[userStreamKey(managerId)]?.items ?? []) : false);
  useEffect(() => { if (manager?.profileId && manager.profileId !== selected) select(manager.profileId); }, [manager?.profileId, select, selected]);
  if (!managerId) return <div className="flex h-full items-center justify-center px-8 text-center text-xs text-muted-foreground">Select a profile to start or resume its Manager conversation.</div>;
  if (!user.data || !manager) return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading Manager…</div>;
  return <div className="flex min-h-0 flex-col border-r border-border"><div className="border-b border-border px-3 py-2"><div className="flex items-center gap-2"><span className="text-sm font-medium">Manager</span><Badge variant="outline">{manager.phase}</Badge></div><p className="text-3xs text-muted-foreground">Read-only workspace · staged profile writes · plan approval applies</p></div>
    {detail.data?.proposal && <div className={cn("border-b px-3 py-2 text-2xs", detail.data.proposal.valid ? "border-status-waiting/40 bg-status-waiting/5" : "border-status-failed/40 bg-status-failed/5")}><span>{detail.data.proposal.files.length} staged file change(s)</span><span className="ml-2 text-muted-foreground">{detail.data.proposal.valid ? "ready for plan approval" : "validation required"}</span></div>}
    <UserTranscript session={user.data.session} onRequestChanges={() => composerRef.current?.focus()} /><Composer ref={composerRef} session={user.data.session} busy={busy} lockMode />
  </div>;
}

function ProfileCard() {
  const workspace = useScopeStore((s) => s.selectedWorkspaceId); const id = useUiStore((s) => s.selectedProfileId); const managerId = useUiStore((s) => s.activeManagerSessionId); const select = useUiStore((s) => s.selectProfile); const selectManager = useUiStore((s) => s.selectManagerSession); const profile = useAgentProfile(workspace, id); const manager = useManagerSession(managerId); const trust = useTrustProfile(); const create = useCreateManagerSession();
  if (!profile.data || !workspace) return manager.data?.proposal ? <ProposalCard proposal={manager.data.proposal} /> : <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Select a profile.</div>;
  const p = profile.data; return <aside className="min-h-0 overflow-y-auto bg-sidebar/30 p-4"><div className="flex items-start gap-3"><div className="min-w-0 flex-1"><h2 className="text-base font-medium">{p.title}</h2><p className="mt-1 text-xs text-muted-foreground">{p.purpose}</p></div><Badge variant="outline">{p.source}</Badge></div>
    <div className="mt-3 flex gap-2">{p.source === "builtin" ? <Button size="sm" variant="outline" onClick={async () => { const session = await create.mutateAsync({ workspaceId: workspace, sourceProfileId: p.id }); select(session.profileKey); selectManager(session.id); }}><Copy className="size-3" />Clone</Button> : !p.trusted ? <Button size="sm" disabled={!p.valid || trust.isPending} onClick={() => trust.mutate({ workspaceId: workspace, profileId: p.id, revision: p.revision })}><ShieldCheck className="size-3" />Enable revision</Button> : <Badge className="gap-1"><ShieldCheck className="size-3" />trusted</Badge>}</div>
    <Section title="Prompt"><pre className="whitespace-pre-wrap font-sans text-2xs text-muted-foreground">{p.instructions}</pre></Section>
    <Section title="Runtime"><div className="flex flex-wrap gap-1">{[p.permissionMode, p.model ?? "default model", p.effort ?? "default effort", `${p.maxTurns} turns`, ...Object.keys(p.mcpServers ?? {}).map((n) => `mcp: ${n}`)].map((x) => <Badge key={x} variant="outline">{x}</Badge>)}</div></Section>
    <Section title={`Tools · ${p.tools.length}`}><div className="flex flex-wrap gap-1">{p.tools.map((tool) => <Badge key={tool} variant="secondary">{tool}</Badge>)}</div></Section>
    <Section title={`Skills · ${p.skills.length}`}><div className="text-2xs text-muted-foreground">{p.skills.join(", ") || "none"}</div></Section>
    <Section title={`Components · ${p.components.length}`}>{p.components.map((c) => <div key={c.path} className="border-b border-border/50 py-1.5 text-2xs"><span className="font-mono">{c.kind}</span> · {c.path}{!c.supported && <span className="ml-1 text-status-waiting">visible only</span>}</div>)}</Section>
    {p.files.length > 0 && <Section title={`Bundle files · ${p.files.length}`}>{p.files.map((file) => <details key={file.path} className="border-b border-border/50 py-1.5 text-2xs"><summary className="cursor-pointer font-mono">{file.path}</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-card p-2 font-mono text-3xs text-muted-foreground">{file.content}</pre></details>)}</Section>}
    {p.issues.length > 0 && <Section title="Validation">{p.issues.map((issue, i) => <p key={i} className={cn("text-2xs", issue.level === "error" ? "text-status-failed" : "text-status-waiting")}>{issue.path}: {issue.message}</p>)}</Section>}
    <p className="mt-4 break-all font-mono text-3xs text-muted-foreground">revision {p.revision}</p>
  </aside>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) { return <section className="mt-5"><h3 className="mb-2 text-3xs uppercase tracking-wider text-muted-foreground">{title}</h3>{children}</section>; }
function ProposalCard({ proposal }: { proposal: NonNullable<ReturnType<typeof useManagerSession>["data"]>["proposal"] }) { if (!proposal) return null; return <aside className="h-full overflow-y-auto bg-sidebar/30 p-4"><h2 className="text-sm font-medium">Staged profile</h2><div className="mt-2 flex gap-1"><Badge variant="outline">{proposal.profileId ?? "new"}</Badge><Badge variant="outline">{proposal.valid ? "valid" : "needs work"}</Badge></div><Section title="Changes">{proposal.files.map((file) => <details key={file.path} className="border-b py-2 text-2xs"><summary className="cursor-pointer font-mono">{file.path}</summary><pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-3xs text-muted-foreground">{file.after ?? "(deleted)"}</pre></details>)}</Section>{proposal.issues.length > 0 && <Section title="Validation">{proposal.issues.map((issue, index) => <p key={index} className={cn("text-2xs", issue.level === "error" ? "text-status-failed" : "text-status-waiting")}>{issue.path}: {issue.message}</p>)}</Section>}</aside>; }
