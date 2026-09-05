import { useMemo } from "react";
import { FolderGit2Icon, MessageSquarePlusIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useLocation, useMatch, useNavigate } from "react-router";
import type { WorkspaceResponse } from "@agentique-console/core";

import { useCreateConversation } from "@/api/mutations";
import { itemsOf, useWorkspaceConversations, useWorkspaceRuns, useWorkspaces } from "@/api/queries";
import { NAV_ITEMS } from "@/app/navigation";
import { StatusDot } from "@/components/status";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command";
import { PHASE_SHORT_LABELS, rowPhaseLabel, rowPhaseOf, rowPhaseTone, shortId, timeAgo } from "@/lib/format";
import { RUN_SECTIONS } from "@/run/sections";
import { useScopeStore } from "@/stores/scope";
import { useThemeStore } from "@/stores/theme";

/**
 * ⌘K: everything reachable by name — pages, the current Run's sections, recent
 * Conversations and Runs, Workspaces, the theme, and a new Conversation.
 */
export function CommandPalette({ open, onOpenChange, workspace }: { open: boolean; onOpenChange: (open: boolean) => void; workspace: WorkspaceResponse }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const runMatch = useMatch("/runs/:runId/*");
  const runId = runMatch?.params.runId ?? null;
  const conversations = useWorkspaceConversations(workspace.workspace.id);
  const runs = useWorkspaceRuns(workspace.workspace.id);
  const workspaces = useWorkspaces();
  const select = useScopeStore((s) => s.select);
  const setTheme = useThemeStore((s) => s.setPreference);
  const create = useCreateConversation();
  const conversationRows = useMemo(() => itemsOf(conversations.data, (c) => c.conversation.id).slice(0, 8), [conversations.data]);
  const runRows = useMemo(() => itemsOf(runs.data, (r) => r.id).slice(0, 8), [runs.data]);
  const workspaceRows = useMemo(() => itemsOf(workspaces.data, (w) => w.workspace.id), [workspaces.data]);
  const go = (to: string) => {
    onOpenChange(false);
    void navigate(to);
  };
  const titleOf = (conversationId: string) => conversationRows.find((c) => c.conversation.id === conversationId)?.conversation.title ?? null;
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search and commands" description="Jump to a page, a Run, or a Conversation; switch the Workspace or the theme." className="sm:max-w-lg">
      <CommandInput placeholder="Where to, or what to do?" autoFocus />
      <CommandList className="max-h-[60vh]">
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading="Go to">
          {NAV_ITEMS.map((item) => (
            <CommandItem key={item.to} value={`go ${item.label}`} onSelect={() => go(item.to)} disabled={item.matches(pathname) && pathname === item.to}>
              <item.Icon />
              {item.label}
              <span className="ml-2 truncate text-2xs text-muted-foreground">{item.hint}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        {runId !== null && (
          <>
            <CommandSeparator />
            <CommandGroup heading={`Run ${shortId(runId)}`}>
              {RUN_SECTIONS.map((section) => (
                <CommandItem key={section.id} value={`run section ${section.label}`} onSelect={() => go(`/runs/${runId}/${section.id}`)}>
                  <section.Icon />
                  {section.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem
            value="new conversation"
            disabled={create.isPending}
            onSelect={() => {
              create.mutate({ workspaceId: workspace.workspace.id, title: null }, { onSuccess: (c) => go(`/conversations/${c.conversation.id}`) });
            }}
          >
            <MessageSquarePlusIcon />
            New Conversation
          </CommandItem>
          <CommandItem value="theme light" onSelect={() => setTheme("light")}>
            <SunIcon />
            Theme: light
          </CommandItem>
          <CommandItem value="theme dark" onSelect={() => setTheme("dark")}>
            <MoonIcon />
            Theme: dark
          </CommandItem>
          <CommandItem value="theme system" onSelect={() => setTheme("system")}>
            <MonitorIcon />
            Theme: follow system
          </CommandItem>
        </CommandGroup>
        {runRows.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Recent Runs">
              {runRows.map((run) => {
                const phase = rowPhaseOf(run);
                return (
                  <CommandItem key={run.id} value={`run ${run.id} ${titleOf(run.conversationId) ?? ""} ${rowPhaseLabel(phase)}`} onSelect={() => go(`/runs/${run.id}`)}>
                    <StatusDot tone={rowPhaseTone(phase)} />
                    <span className="truncate">{titleOf(run.conversationId) ?? shortId(run.id)}</span>
                    <span className="truncate text-2xs text-muted-foreground">{phase === "completed" ? "Completed" : PHASE_SHORT_LABELS[phase]}</span>
                    <CommandShortcut>{timeAgo(run.createdAt)}</CommandShortcut>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}
        {conversationRows.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Recent Conversations">
              {conversationRows.map((row) => (
                <CommandItem key={row.conversation.id} value={`conversation ${row.conversation.title ?? "untitled"} ${row.conversation.id}`} onSelect={() => go(`/conversations/${row.conversation.id}`)}>
                  <span className="truncate">{row.conversation.title ?? "Untitled conversation"}</span>
                  <CommandShortcut>{timeAgo(row.conversation.updatedAt)}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        {workspaceRows.length > 1 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Switch Workspace">
              {workspaceRows
                .filter((row) => row.workspace.id !== workspace.workspace.id)
                .map((row) => (
                  <CommandItem
                    key={row.workspace.id}
                    value={`workspace ${row.workspace.name} ${row.workspace.rootPath}`}
                    onSelect={() => {
                      onOpenChange(false);
                      select(row.workspace.id);
                    }}
                  >
                    <FolderGit2Icon />
                    <span className="truncate">{row.workspace.name}</span>
                    <span className="truncate text-2xs text-muted-foreground">{row.workspace.rootPath}</span>
                  </CommandItem>
                ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
