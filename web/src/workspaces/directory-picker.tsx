import { useEffect, useState } from "react";
import { ChevronRight, Folder, Home } from "lucide-react";

import { useFsDirs, useFsRoots } from "@/api/queries";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { cn, errorMessage } from "@/lib/utils";

import { breadcrumbs } from "./path";

/**
 * Picks a directory on the machine the SERVER runs on.
 *
 * The browser's own `showDirectoryPicker()` is useless here: it hands back a
 * handle with no absolute path, and the server needs a path. So the server
 * lists directories (confined to an allow-list) and this walks them.
 */
export function DirectoryPicker({
  path,
  onPathChange,
}: {
  /** null until the roots resolve, then always an absolute path. */
  readonly path: string | null;
  readonly onPathChange: (path: string) => void;
}) {
  const roots = useFsRoots();
  const [showHidden, setShowHidden] = useState(false);
  const listing = useFsDirs(path, showHidden);
  const [typed, setTyped] = useState(path ?? "");

  // Start at the first allowed root, and keep the text field in step with navigation.
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
      {/* Breadcrumb — doubles as up-navigation; `parent` is redundant with it. */}
      <div className="flex flex-wrap items-center gap-0.5 text-[11px] text-muted-foreground">
        {crumbs.map((crumb, index) => (
          <span key={crumb.path} className="flex items-center">
            {index > 0 && <span className="px-0.5 opacity-40">/</span>}
            <button
              type="button"
              className="rounded px-1 hover:bg-muted/60 hover:text-foreground"
              onClick={() => onPathChange(crumb.path)}
            >
              {crumb.label === "/" ? <Home className="size-3" /> : crumb.label}
            </button>
          </span>
        ))}
      </div>

      {/* Typed path — the only way to reach an arbitrary absolute path, and paste-friendly. */}
      <Input
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onPathChange(typed.trim());
          }
        }}
        placeholder="/home/you/git"
        aria-label="directory path"
        className="h-8 font-mono text-xs"
      />
      {listing.isError && (
        <div className="text-[11px] text-status-failed">
          {errorMessage(listing.error)}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1 rounded border border-border">
        <div className="flex flex-col p-1">
          {listing.isPending && (
            <div className="flex items-center justify-center py-8">
              <Spinner className="size-4 text-muted-foreground" />
            </div>
          )}
          {listing.isSuccess && entries.length === 0 && (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              No subdirectories here.
            </div>
          )}
          {entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => onPathChange(entry.path)}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted/50"
            >
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  entry.hidden && "opacity-60",
                )}
              >
                {entry.name}
              </span>
              <ChevronRight className="size-3 shrink-0 opacity-40" />
            </button>
          ))}
        </div>
      </ScrollArea>

      <Label className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Checkbox
          checked={showHidden}
          onCheckedChange={(checked) => setShowHidden(checked === true)}
        />
        show hidden
      </Label>
    </div>
  );
}
