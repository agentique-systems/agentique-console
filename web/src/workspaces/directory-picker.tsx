import { useEffect, useState } from "react";
import { Check, ChevronRight, Folder, FolderPlus, Home, X } from "lucide-react";

import { useFsDirs, useFsRoots } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { cn, errorMessage } from "@/lib/utils";

import { breadcrumbs, joinPath } from "./path";

/** Browse server directories and select the directory shown as the workspace. */
export function DirectoryPicker({
  path,
  onPathChange,
  onNewFolder,
}: {
  readonly path: string | null;
  readonly onPathChange: (path: string) => void;
  readonly onNewFolder: (path: string) => void;
}) {
  const roots = useFsRoots();
  const [showHidden, setShowHidden] = useState(false);
  const listing = useFsDirs(path, showHidden);
  const [typed, setTyped] = useState(path ?? "");
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState("");

  useEffect(() => {
    if (path === null && roots.data !== undefined) {
      const first = roots.data.roots[0]?.path;
      if (first !== undefined) onPathChange(first);
    }
  }, [path, roots.data, onPathChange]);
  useEffect(() => {
    if (path !== null) setTyped(path);
    setCreating(false);
    setFolderName("");
  }, [path]);

  const crumbs = breadcrumbs(listing.data?.path ?? path ?? "");
  const entries = listing.data?.entries ?? [];
  const createFolder = () => {
    const nextName = folderName.trim();
    if (path === null || nextName === "" || nextName.includes("/")) return;
    onNewFolder(joinPath(path, nextName));
    setCreating(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-0.5 text-2xs text-muted-foreground">
          {crumbs.map((crumb, index) => (
            <span key={crumb.path} className="flex items-center">
              {index > 0 && <span className="px-0.5 opacity-40">/</span>}
              <button type="button" className="rounded-sm px-1 hover:bg-muted hover:text-foreground" onClick={() => onPathChange(crumb.path)}>
                {crumb.label === "/" ? <Home className="size-3" /> : crumb.label}
              </button>
            </span>
          ))}
        </div>
        <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 gap-1.5 text-2xs" onClick={() => setCreating(true)} disabled={path === null || listing.isError}>
          <FolderPlus className="size-3.5" />New folder
        </Button>
      </div>

      <Input
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            onPathChange(typed.trim());
          }
        }}
        placeholder="/home/you/git"
        aria-label="directory path"
        className="h-8 font-mono text-xs"
      />
      {listing.isError && <div className="text-2xs text-status-failed">{errorMessage(listing.error)}</div>}

      <ScrollArea className="min-h-0 flex-1 rounded-lg border border-border bg-background">
        <div className="flex flex-col p-1.5">
          {creating && (
            <div className="mb-1 flex items-center gap-2 rounded-md border border-primary/30 bg-accent p-2">
              <FolderPlus className="size-4 shrink-0 text-primary" />
              <Input
                autoFocus
                value={folderName}
                onChange={(event) => setFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setCreating(false);
                  if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                    event.preventDefault();
                    createFolder();
                  }
                }}
                aria-label="new folder name"
                placeholder="Folder name"
                className="h-7 bg-card font-mono text-xs"
              />
              <Button type="button" size="icon" className="size-7" aria-label="Choose new folder" onClick={createFolder} disabled={folderName.trim() === "" || folderName.includes("/")}><Check className="size-3.5" /></Button>
              <Button type="button" size="icon" variant="ghost" className="size-7" aria-label="Cancel new folder" onClick={() => setCreating(false)}><X className="size-3.5" /></Button>
            </div>
          )}
          {listing.isPending && <div className="flex items-center justify-center py-8"><Spinner className="size-4 text-muted-foreground" /></div>}
          {listing.isSuccess && entries.length === 0 && !creating && <div className="px-2 py-8 text-center text-xs text-muted-foreground">This folder has no subfolders.</div>}
          {entries.map((entry) => (
            <button key={entry.path} type="button" onClick={() => onPathChange(entry.path)} className="flex items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted">
              <Folder className="size-3.5 shrink-0 text-primary" />
              <span className={cn("min-w-0 flex-1 truncate", entry.hidden && "opacity-60")}>{entry.name}</span>
              <ChevronRight className="size-3 shrink-0 opacity-40" />
            </button>
          ))}
        </div>
      </ScrollArea>

      <div className="flex items-center justify-between gap-3">
        <Label className="flex items-center gap-2 text-2xs text-muted-foreground"><Checkbox checked={showHidden} onCheckedChange={(checked) => setShowHidden(checked === true)} />Show hidden folders</Label>
        <span className="text-3xs text-muted-foreground">Open a folder to select it</span>
      </div>
    </div>
  );
}
