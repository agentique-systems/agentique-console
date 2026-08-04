import { useState } from "react";
import { ArrowLeft } from "lucide-react";

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
import { cn, errorMessage } from "@/lib/utils";
import { useScopeStore } from "@/stores/scope";

import { DirectoryPicker } from "./directory-picker";
import { joinPath } from "./path";

type Step = "location" | "name";

const STEPS: readonly Step[] = ["location", "name"];

/**
 * Creating a workspace: pick where it lives, then name the folder the server
 * will create there (`create: true` — the directory is minted, not adopted).
 *
 * A Dialog rather than an inline panel for one decisive reason: it must render
 * on the first-run gate, where there is no shell at all.
 */
export function WorkspaceWizard({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateWorkspace();
  const [step, setStep] = useState<Step>("location");
  const [path, setPath] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [name, setName] = useState("");
  const [touchedName, setTouchedName] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const index = Math.max(0, STEPS.indexOf(step));

  const reset = () => {
    setStep("location");
    setPath(null);
    setFolderName("");
    setName("");
    setTouchedName(false);
    setError(null);
    create.reset();
  };

  const close = (next: boolean) => {
    // A create in flight would be orphaned by dismissing mid-flight.
    if (!next && create.isPending) return;
    if (!next) reset();
    onOpenChange(next);
  };

  /** The name defaults from the folder, until the operator types their own. */
  const effectiveName = touchedName ? name : folderName.trim();
  const rootPath =
    path === null || folderName.trim() === ""
      ? null
      : joinPath(path, folderName.trim());

  const canAdvance =
    (step === "location" && path !== null) ||
    (step === "name" && rootPath !== null && effectiveName.trim().length > 0);

  const advance = () => {
    const next = STEPS[index + 1];
    if (next !== undefined) setStep(next);
  };

  const back = () => {
    const previous = STEPS[index - 1];
    if (previous !== undefined) {
      setError(null);
      setStep(previous);
    }
  };

  const submit = () => {
    if (rootPath === null) return;
    setError(null);
    create.mutate(
      { name: effectiveName.trim(), rootPath, create: true },
      {
        onSuccess: (workspace) => {
          reset();
          onOpenChange(false);
          // Landing in the workspace you just made is the point.
          useScopeStore.getState().select(workspace.id);
        },
        onError: setError,
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>
            A workspace is a directory on this machine. The console creates it
            where you point.
          </DialogDescription>
        </DialogHeader>

        {/* Progress: a dot row, not a stepper component. */}
        <div className="flex gap-1">
          {STEPS.map((entry, position) => (
            <span
              key={entry}
              className={cn(
                "h-1 w-8 rounded-full",
                position <= index ? "bg-primary" : "bg-border",
              )}
            />
          ))}
        </div>

        {/* Fixed height so the dialog does not jump between steps. */}
        <div className="flex h-[24rem] min-h-0 flex-col gap-3">
          {step === "location" && (
            <DirectoryPicker path={path} onPathChange={setPath} />
          )}

          {step === "name" && (
            <div className="flex flex-col gap-3 pt-2">
              <Field
                label="Folder name"
                input={
                  <Input
                    autoFocus
                    value={folderName}
                    onChange={(event) => setFolderName(event.target.value)}
                    placeholder="my-workspace"
                    aria-label="folder name"
                    className="h-8 font-mono text-xs"
                  />
                }
              />
              <Field
                label="Workspace name"
                input={
                  <Input
                    value={effectiveName}
                    onChange={(event) => {
                      setTouchedName(true);
                      setName(event.target.value);
                    }}
                    placeholder="my-workspace"
                    aria-label="workspace name"
                    className="h-8"
                  />
                }
              />
              <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 rounded-md border border-border p-3 text-xs">
                <Summary label="Inside" value={path ?? "—"} />
                <Summary label="Directory" value={rootPath ?? "—"} />
              </dl>
            </div>
          )}
        </div>

        {error !== null && (
          <p
            className="text-2xs text-status-failed"
            data-testid="wizard-error"
          >
            {errorMessage(error)}
          </p>
        )}

        <div className="flex items-center gap-2">
          {index > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={back}
            >
              <ArrowLeft className="size-3.5" />
              Back
            </Button>
          )}
          <span className="flex-1" />
          {step === "name" ? (
            <Button
              size="sm"
              disabled={!canAdvance || create.isPending}
              onClick={submit}
            >
              {create.isPending ? "Creating…" : "Create workspace"}
            </Button>
          ) : (
            <Button size="sm" disabled={!canAdvance} onClick={advance}>
              Next
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  input,
}: {
  readonly label: string;
  readonly input: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-2xs text-muted-foreground">{label}</Label>
      {input}
    </div>
  );
}

function Summary({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-2xs">{value}</dd>
    </>
  );
}
