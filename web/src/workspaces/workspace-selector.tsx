import { useState } from "react";
import { Check, ChevronDown, FolderGit2, Plus } from "lucide-react";

import { useWorkspaces } from "@/api/queries";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useScopeStore } from "@/stores/scope";

import { WorkspaceWizard } from "./workspace-wizard";

/** The last path segments — the whole path is too wide for the topbar. */
function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

/**
 * Which workspace the console is looking at, ported from v1's HUD selector.
 *
 * A combobox (Popover + Command), NOT a DropdownMenu — the row count grows with
 * the operator's machine and this needs real search; DropdownMenu's typeahead is
 * single-character and has no filter.
 */
export function WorkspaceSelector() {
  const [open, setOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const selectedId = useScopeStore((s) => s.selectedWorkspaceId);
  const select = useScopeStore((s) => s.select);
  const workspaces = useWorkspaces().data ?? [];

  const active = workspaces.find((workspace) => workspace.id === selectedId);
  const label =
    active?.name ?? (workspaces.length === 0 ? "no workspaces" : "pick one");

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex max-w-52 shrink-0 items-center gap-1.5 truncate rounded-md border border-border px-2 py-0.5 text-2xs hover:bg-muted/40"
            title="Switch workspace"
            data-testid="workspace-selector"
          >
            <FolderGit2 className="size-3 shrink-0" />
            <span className="truncate font-medium text-foreground">
              {label}
            </span>
            <ChevronDown className="size-3 shrink-0 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-0">
          <Command>
            <CommandInput placeholder="search workspaces…" />
            <CommandList>
              <CommandEmpty>No workspace matches.</CommandEmpty>
              <CommandGroup>
                {workspaces.map((workspace) => (
                  <CommandItem
                    key={workspace.id}
                    // Search hits the directory too, not just the name.
                    value={`${workspace.name} ${workspace.rootPath}`}
                    onSelect={() => {
                      select(workspace.id);
                      setOpen(false);
                    }}
                    className="flex items-start gap-2"
                  >
                    <Check
                      className={cn(
                        "mt-0.5 size-3.5 shrink-0",
                        workspace.id === selectedId
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {workspace.name}
                      </span>
                      <span className="block truncate text-3xs text-muted-foreground">
                        {shortPath(workspace.rootPath)}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
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
                  New workspace…
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
