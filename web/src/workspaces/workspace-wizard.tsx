import { useState } from "react";
import { FolderCheck, FolderPlus } from "lucide-react";

import { useCreateWorkspace } from "@/api/mutations";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/utils";
import { useScopeStore } from "@/stores/scope";

import { DirectoryPicker } from "./directory-picker";
import { basename } from "./path";

/** Select an existing directory, or define a new child directory inline. */
export function WorkspaceWizard({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateWorkspace();
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [createDirectory, setCreateDirectory] = useState(false);
  const [name, setName] = useState("");
  const [touchedName, setTouchedName] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const reset = () => {
    setBrowsePath(null);
    setSelectedPath(null);
    setCreateDirectory(false);
    setName("");
    setTouchedName(false);
    setError(null);
    create.reset();
  };

  const close = (next: boolean) => {
    if (!next && create.isPending) return;
    if (!next) reset();
    onOpenChange(next);
  };

  const selectExisting = (path: string) => {
    setBrowsePath(path);
    setSelectedPath(path);
    setCreateDirectory(false);
    setError(null);
    if (!touchedName) setName("");
  };

  const selectNew = (path: string) => {
    setSelectedPath(path);
    setCreateDirectory(true);
    setError(null);
    if (!touchedName) setName("");
  };

  const effectiveName = touchedName ? name.trim() : basename(selectedPath ?? "");
  const canSubmit = selectedPath !== null && effectiveName.length > 0;

  const submit = () => {
    if (!canSubmit || selectedPath === null) return;
    setError(null);
    create.mutate(
      { name: effectiveName, rootPath: selectedPath, create: createDirectory },
      {
        onSuccess: (workspace) => {
          reset();
          onOpenChange(false);
          useScopeStore.getState().select(workspace.id);
        },
        onError: setError,
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>Select workspace folder</DialogTitle>
          <DialogDescription>
            Open the directory you want to use. To start fresh, create a folder directly in the browser below.
          </DialogDescription>
        </DialogHeader>

        <div className="flex h-[25rem] min-h-0 flex-col">
          <DirectoryPicker path={browsePath} onPathChange={selectExisting} onNewFolder={selectNew} />
        </div>

        <div className="rounded-lg border border-border bg-muted/50 p-3">
          <div className="flex items-start gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
              {createDirectory ? <FolderPlus className="size-4" /> : <FolderCheck className="size-4" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <span className="text-2xs font-medium">{createDirectory ? "New workspace folder" : "Selected folder"}</span>
                {createDirectory && <span className="rounded-full bg-accent px-2 py-0.5 text-3xs text-accent-foreground">Created on confirmation</span>}
              </div>
              <div className="mt-1 truncate font-mono text-xs" title={selectedPath ?? undefined}>{selectedPath ?? "Choose a folder above"}</div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <Label htmlFor="workspace-name" className="text-xs">Workspace name <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <span className="text-3xs text-muted-foreground">Defaults to the folder name</span>
          </div>
          <Input
            id="workspace-name"
            value={touchedName ? name : effectiveName}
            onChange={(event) => { setTouchedName(true); setName(event.target.value); }}
            placeholder="Workspace name"
            className="h-8"
          />
        </div>

        {error !== null && <p className="text-2xs text-status-failed" data-testid="wizard-error">{errorMessage(error)}</p>}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={create.isPending} onClick={() => close(false)}>Cancel</Button>
          <Button size="sm" disabled={!canSubmit || create.isPending} onClick={submit}>
            {create.isPending ? "Adding…" : createDirectory ? "Create workspace" : "Use this folder"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
