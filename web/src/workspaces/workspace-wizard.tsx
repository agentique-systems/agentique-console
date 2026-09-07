import { useState } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { useCreateWorkspace } from "@/api/mutations";
import { Callout } from "@/components/callout";
import { KeyValueTable } from "@/components/key-value";
import { errorMessage } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useScopeStore } from "@/stores/scope";
import { DirectoryPicker } from "./directory-picker";
import { joinPath } from "./path";

type Step = "location" | "name";
const STEPS: readonly { id: Step; label: string }[] = [
  { id: "location", label: "Directory" },
  { id: "name", label: "Name" },
];

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
  const index = Math.max(
    0,
    STEPS.findIndex((s) => s.id === step),
  );

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
      <DialogContent className="max-w-2xl gap-4" data-testid="workspace-wizard">
        <DialogHeader>
          <DialogTitle>New Workspace</DialogTitle>
          <DialogDescription>A Workspace is a directory on this machine. Adopt an existing repository or directory, or create a new folder inside one.</DialogDescription>
        </DialogHeader>
        <ol className="flex items-center gap-2 text-xs" aria-label="Steps">
          {STEPS.map((entry, position) => (
            <li key={entry.id} className="flex items-center gap-2">
              <span className={cn("flex size-5 items-center justify-center rounded-full border font-mono text-2xs", position < index ? "border-foreground bg-foreground text-background" : position === index ? "border-foreground text-foreground" : "border-border text-muted-foreground")} aria-current={position === index ? "step" : undefined}>
                {position + 1}
              </span>
              <span className={cn(position === index ? "font-medium text-foreground" : "text-muted-foreground")}>{entry.label}</span>
              {position < STEPS.length - 1 && <span className="h-px w-6 bg-border" aria-hidden />}
            </li>
          ))}
        </ol>
        <div className="flex h-[24rem] min-h-0 flex-col gap-3">
          {step === "location" && <DirectoryPicker path={path} onPathChange={setPath} />}
          {step === "name" && (
            <div className="flex flex-col gap-4 pt-1">
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="directory">
                <ChoiceCard checked={mode === "adopt"} onSelect={() => setMode("adopt")} title="Use this directory" description="Adopt the selected directory as it is; a git repository root becomes a git Workspace." />
                <ChoiceCard checked={mode === "create"} onSelect={() => setMode("create")} title="Create a folder inside it" description="Create a new, empty folder under the selected directory." />
              </div>
              {mode === "create" && <Field label="Folder name" input={<Input autoFocus value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="my-project" aria-label="folder name" className="font-mono" />} />}
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
                  />
                }
              />
              <div className="rounded-md border border-border bg-muted/40 p-3">
                <KeyValueTable items={[{ label: "Directory", value: rootPath ?? "—", mono: true }]} />
              </div>
            </div>
          )}
        </div>
        {error !== null && (
          <Callout tone="error" testId="wizard-error">
            {errorMessage(error)}
          </Callout>
        )}
        <div className="flex items-center gap-2">
          {index > 0 && (
            <Button variant="ghost" onClick={() => setStep("location")}>
              <ArrowLeftIcon />
              Back
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="ghost" onClick={() => close(false)} disabled={create.isPending}>
            Cancel
          </Button>
          {step === "name" ? (
            <Button disabled={!canAdvance || create.isPending} onClick={submit}>
              {create.isPending ? "Creating…" : "Add Workspace"}
            </Button>
          ) : (
            <Button disabled={!canAdvance} onClick={() => setStep("name")}>
              Next
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChoiceCard({ checked, onSelect, title, description }: { checked: boolean; onSelect: () => void; title: string; description: string }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2.5 rounded-md border p-3 text-sm transition-colors", checked ? "border-foreground/60 bg-accent/50" : "border-border hover:bg-accent/30")}>
      <input type="radio" name="mode" checked={checked} onChange={onSelect} className="mt-0.5" />
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

function Field({ label, input }: { readonly label: string; readonly input: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {input}
    </div>
  );
}
