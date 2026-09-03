import { useState } from "react";
import { Check, ChevronDown, FolderGit2, Plus } from "lucide-react";
import type { WorkspaceResponse } from "@agentique-console/core";
import { itemsOf, useWorkspaces } from "@/api/queries";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useScopeStore } from "@/stores/scope";
import { WorkspaceWizard } from "./workspace-wizard";

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

/** Which Workspace the console is looking at: a searchable combobox, since the list grows with the machine. */
export function WorkspaceSelector({ selected }: { selected: WorkspaceResponse }) {
  const [open, setOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const select = useScopeStore((s) => s.select);
  const paged = useWorkspaces();
  const workspaces = itemsOf(paged.data, (row) => row.workspace.id);
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="flex max-w-52 shrink-0 items-center gap-1.5 truncate rounded-md border border-border px-2 py-0.5 text-2xs hover:bg-muted/40" title="Switch Workspace" data-testid="workspace-selector">
            <FolderGit2 className="size-3 shrink-0" />
            <span className="truncate font-medium text-foreground">{selected.workspace.name}</span>
            <ChevronDown className="size-3 shrink-0 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-0">
          <Command>
            <CommandInput placeholder="search Workspaces…" />
            <CommandList>
              <CommandEmpty>No Workspace matches.</CommandEmpty>
              <CommandGroup>
                {workspaces.map((row) => (
                  <CommandItem
                    key={row.workspace.id}
                    value={`${row.workspace.name} ${row.workspace.rootPath}`}
                    onSelect={() => {
                      select(row.workspace.id);
                      setOpen(false);
                    }}
                    className="flex items-start gap-2"
                  >
                    <Check className={cn("mt-0.5 size-3.5 shrink-0", row.workspace.id === selected.workspace.id ? "opacity-100" : "opacity-0")} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{row.workspace.name}</span>
                      <span className="block truncate text-3xs text-muted-foreground">{shortPath(row.workspace.rootPath)}</span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
              {paged.hasNextPage && (
                <CommandGroup>
                  <CommandItem value="load more workspaces" onSelect={() => void paged.fetchNextPage()} className="gap-2" data-testid="workspaces-more">
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
                  className="gap-2"
                >
                  <Plus className="size-3.5" />
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
