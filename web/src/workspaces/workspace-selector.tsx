import { useState } from "react";
import { CheckIcon, ChevronsUpDownIcon, FolderGit2Icon, FolderIcon, PlusIcon } from "lucide-react";
import type { WorkspaceResponse } from "@agentique-console/core";

import { itemsOf, useWorkspaces } from "@/api/queries";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useScopeStore } from "@/stores/scope";
import { WorkspaceWizard } from "./workspace-wizard";

export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

/**
 * Which Workspace the console is looking at: a searchable combobox, since the
 * list grows with the machine. `sidebar` is the two-line rail trigger, `icon`
 * the collapsed rail, `compact` a one-line chip.
 */
export function WorkspaceSelector({ selected, variant = "compact" }: { selected: WorkspaceResponse; variant?: "sidebar" | "icon" | "compact" }) {
  const [open, setOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const select = useScopeStore((s) => s.select);
  const paged = useWorkspaces();
  const workspaces = itemsOf(paged.data, (row) => row.workspace.id);
  const KindIcon = selected.workspace.kind === "git" ? FolderGit2Icon : FolderIcon;
  const trigger =
    variant === "icon" ? (
      <button type="button" className="flex size-8 items-center justify-center rounded-md border border-border bg-background/60 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Workspace: ${selected.workspace.name}. Switch Workspace`} data-testid="workspace-selector">
        <KindIcon className="size-4" />
      </button>
    ) : variant === "sidebar" ? (
      <button type="button" className="flex h-11 w-full items-center gap-2 rounded-md border border-border bg-background/60 px-2 text-left hover:bg-background focus-visible:outline-2 focus-visible:outline-ring" aria-label="Switch Workspace" data-testid="workspace-selector">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <KindIcon className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-xs font-medium text-foreground">{selected.workspace.name}</span>
          <span className="truncate font-mono text-3xs text-muted-foreground" title={selected.workspace.rootPath}>
            {shortPath(selected.workspace.rootPath)}
          </span>
        </span>
        <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
    ) : (
      <button type="button" className="flex h-7 max-w-52 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" aria-label="Switch Workspace" data-testid="workspace-selector">
        <KindIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium text-foreground">{selected.workspace.name}</span>
        <ChevronsUpDownIcon className="size-3 shrink-0 text-muted-foreground" />
      </button>
    );
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        {variant === "icon" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>{trigger}</PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="right">{selected.workspace.name}</TooltipContent>
          </Tooltip>
        ) : (
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        )}
        <PopoverContent align="start" className="w-80 p-0">
          <Command>
            <CommandInput placeholder="Search Workspaces…" />
            <CommandList>
              <CommandEmpty>No Workspace matches.</CommandEmpty>
              <CommandGroup heading="Workspaces">
                {workspaces.map((row) => (
                  <CommandItem
                    key={row.workspace.id}
                    value={`${row.workspace.name} ${row.workspace.rootPath}`}
                    onSelect={() => {
                      select(row.workspace.id);
                      setOpen(false);
                    }}
                    className="items-start gap-2"
                  >
                    <CheckIcon className={cn("mt-0.5 size-3.5 shrink-0", row.workspace.id === selected.workspace.id ? "opacity-100" : "opacity-0")} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{row.workspace.name}</span>
                      <span className="block truncate font-mono text-3xs text-muted-foreground">{shortPath(row.workspace.rootPath)}</span>
                    </span>
                    <span className="text-2xs text-muted-foreground">{row.workspace.kind === "git" ? "git" : "dir"}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
              {paged.hasNextPage && (
                <CommandGroup>
                  <CommandItem value="load more workspaces" onSelect={() => void paged.fetchNextPage()} className="justify-center text-muted-foreground" data-testid="workspaces-more">
                    {paged.isFetchingNextPage ? "Loading…" : "Load more Workspaces…"}
                  </CommandItem>
                </CommandGroup>
              )}
              <CommandSeparator />
              <CommandGroup>
                <CommandItem
                  value="new workspace"
                  onSelect={() => {
                    setOpen(false);
                    setWizardOpen(true);
                  }}
                >
                  <PlusIcon />
                  New Workspace…
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <WorkspaceWizard open={wizardOpen} onOpenChange={setWizardOpen} />
    </>
  );
}
