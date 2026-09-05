import { useEffect, useState } from "react";
import { ChevronRightIcon, FolderIcon, HouseIcon } from "lucide-react";

import { useFsDirs, useFsRoots } from "@/api/queries";
import { errorMessage } from "@/components/panel";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { breadcrumbs } from "./path";

/** Picks a directory on the machine the server runs on: the server lists directories under its browse roots and this walks them. */
export function DirectoryPicker({ path, onPathChange }: { readonly path: string | null; readonly onPathChange: (path: string) => void }) {
  const roots = useFsRoots();
  const [showHidden, setShowHidden] = useState(false);
  const listing = useFsDirs(path, showHidden);
  const [typed, setTyped] = useState(path ?? "");
  useEffect(() => {
    if (path === null && roots.data !== undefined) {
      const first = roots.data.roots[0]?.path;
      if (first !== undefined) onPathChange(first);
    }
  }, [path, roots.data, onPathChange]);
  useEffect(() => {
    if (path !== null) setTyped(path);
  }, [path]);
  const crumbs = breadcrumbs(listing.data?.path ?? path ?? "");
  const entries = listing.data?.entries ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <nav aria-label="Path" className="flex flex-wrap items-center gap-0.5 text-xs text-muted-foreground">
        {crumbs.map((crumb, index) => (
          <span key={crumb.path} className="flex items-center">
            {index > 0 && <ChevronRightIcon className="size-3 opacity-50" aria-hidden />}
            <button type="button" className="rounded-sm px-1 py-0.5 hover:bg-accent hover:text-foreground" onClick={() => onPathChange(crumb.path)}>
              {crumb.label === "/" ? <HouseIcon className="size-3" aria-label="root" /> : crumb.label}
            </button>
          </span>
        ))}
      </nav>
      <Input
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onPathChange(typed.trim());
          }
        }}
        placeholder="An absolute path; Enter to open it"
        aria-label="directory path"
        className="font-mono text-xs"
      />
      {listing.isError && <div className="text-xs text-status-failed">{errorMessage(listing.error)}</div>}
      <ScrollArea className="min-h-0 flex-1 rounded-md border border-border bg-card">
        <div className="flex flex-col p-1">
          {listing.isPending && path !== null && (
            <div className="flex items-center justify-center py-8">
              <Spinner className="size-4 text-muted-foreground" />
            </div>
          )}
          {listing.isSuccess && entries.length === 0 && <div className="px-2 py-8 text-center text-xs text-muted-foreground">No subdirectories here. Use this directory, or create a folder inside it on the next step.</div>}
          {entries.map((entry) => (
            <button key={entry.path} type="button" onClick={() => onPathChange(entry.path)} className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className={cn("min-w-0 flex-1 truncate", entry.hidden && "text-muted-foreground")}>{entry.name}</span>
              <ChevronRightIcon className="size-3.5 shrink-0 opacity-40" />
            </button>
          ))}
        </div>
      </ScrollArea>
      <Label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox checked={showHidden} onCheckedChange={(checked) => setShowHidden(checked === true)} />
        Show hidden directories
      </Label>
    </div>
  );
}
