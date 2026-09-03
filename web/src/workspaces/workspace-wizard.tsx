import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useCreateWorkspace } from "@/api/mutations";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/components/panel";
import { cn } from "@/lib/utils";
import { useScopeStore } from "@/stores/scope";
import { DirectoryPicker } from "./directory-picker";
import { joinPath } from "./path";

type Step = "location" | "name";
const STEPS: readonly Step[] = ["location", "name"];

/**
 * Adding a Workspace: pick a directory under the browse roots (an existing
 * repository or directory is adopted; a new folder is created), then name
 * it. A Dialog, because it must render on the first-run gate too.
 */
export function WorkspaceWizard({ open, onOpenChange }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  const create = useCreateWorkspace();
  const [step, setStep] = useState<Step>("location");
  const [path, setPath] = useState<string | null>(null);
  const [mode, setMode] = useState<"adopt" | "create">("adopt");
  const [folderName, setFolderName] = useState("");
  const [name, setName] = useState("");
  const [touchedName, setTouchedName] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const index = Math.max(0, STEPS.indexOf(step));

  const reset = () => {
    setStep("location");
    setPath(null);
    setMode("adopt");
    setFolderName("");
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
  const rootPath = path === null ? null : mode === "adopt" ? path : folderName.trim() === "" ? null : joinPath(path, folderName.trim());
  const defaultName = rootPath === null ? "" : (rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "");
  const effectiveName = touchedName ? name : defaultName;
  const canAdvance = (step === "location" && path !== null) || (step === "name" && rootPath !== null && effectiveName.trim().length > 0);

  const submit = () => {
    if (rootPath === null) return;
    setError(null);
    create.mutate(
      { name: effectiveName.trim(), rootPath, create: mode === "create" },
      {
        onSuccess: (created) => {
          reset();
          onOpenChange(false);
          useScopeStore.getState().select(created.workspace.id);
        },
        onError: setError,
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl" data-testid="workspace-wizard">
        <DialogHeader>
          <DialogTitle>New Workspace</DialogTitle>
          <DialogDescription>A Workspace is a directory on this machine. Adopt an existing repository or directory, or create a new folder.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1">
          {STEPS.map((entry, position) => (
            <span key={entry} className={cn("h-1 w-8 rounded-full", position <= index ? "bg-primary" : "bg-border")} />
          ))}
        </div>
        <div className="flex h-[24rem] min-h-0 flex-col gap-3">
          {step === "location" && <DirectoryPicker path={path} onPathChange={setPath} />}
          {step === "name" && (
            <div className="flex flex-col gap-3 pt-2">
              <div className="flex gap-2 text-xs" role="radiogroup" aria-label="directory">
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="mode" checked={mode === "adopt"} onChange={() => setMode("adopt")} /> Use this directory
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="mode" checked={mode === "create"} onChange={() => setMode("create")} /> Create a folder inside it
                </label>
              </div>
              {mode === "create" && (
                <Field label="Folder name" input={<Input autoFocus value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="my-project" aria-label="folder name" className="h-8 font-mono text-xs" />} />
              )}
              <Field
                label="Workspace name"
                input={
                  <Input
                    value={effectiveName}
                    onChange={(event) => {
                      setTouchedName(true);
                      setName(event.target.value);
                    }}
                    placeholder="my-project"
                    aria-label="workspace name"
                    className="h-8"
                  />
                }
              />
              <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 rounded-md border border-border p-3 text-xs">
                <dt className="text-muted-foreground">Directory</dt>
                <dd className="truncate font-mono text-2xs">{rootPath ?? "—"}</dd>
              </dl>
            </div>
          )}
        </div>
        {error !== null && (
          <p className="text-2xs text-status-failed" data-testid="wizard-error">
            {errorMessage(error)}
          </p>
        )}
        <div className="flex items-center gap-2">
          {index > 0 && (
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setStep("location")}>
              <ArrowLeft className="size-3.5" />
              Back
            </Button>
          )}
          <span className="flex-1" />
          {step === "name" ? (
            <Button size="sm" disabled={!canAdvance || create.isPending} onClick={submit}>
              {create.isPending ? "Creating…" : "Add Workspace"}
            </Button>
          ) : (
            <Button size="sm" disabled={!canAdvance} onClick={() => setStep("name")}>
              Next
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, input }: { readonly label: string; readonly input: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-2xs text-muted-foreground">{label}</Label>
      {input}
    </div>
  );
}
