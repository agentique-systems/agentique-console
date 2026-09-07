import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DownloadIcon, FileTextIcon } from "lucide-react";
import { apiPath, type Artifact } from "@agentique-console/core";

import { api, apiUrl } from "@/api/client";
import { keys } from "@/api/keys";
import { useArtifact, useArtifactText } from "@/api/queries";
import { IdChip } from "@/components/id-chip";
import { CodeBlock } from "@/components/log-view";
import { Markdown } from "@/components/markdown";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SkeletonLines } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function bytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

/** A link that opens an Artifact in the viewer (text and JSON inline, everything else as a download). */
export function ArtifactLink(props: { artifact?: Artifact; artifactId?: string; changesetId?: string; runId?: string; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const changeset = useQuery({ queryKey: keys.runPart(props.runId ?? "", `changeset-${props.changesetId ?? ""}`), queryFn: () => api("getChangeset", { params: { changesetId: props.changesetId! } }), enabled: props.changesetId !== undefined });
  const artifactId = props.artifact?.id ?? props.artifactId ?? changeset.data?.diffArtifactId ?? null;
  const label = props.label ?? props.artifact?.title ?? artifactId?.slice(0, 16) ?? "artifact";
  if (artifactId === null) return <span className="text-muted-foreground">{label}</span>;
  return (
    <>
      <button type="button" className={cn("inline-flex max-w-full items-center gap-1 text-left underline decoration-dotted underline-offset-2 hover:decoration-solid", props.className)} onClick={() => setOpen(true)} data-artifact={artifactId}>
        <FileTextIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{label}</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-sm">{label}</DialogTitle>
            <DialogDescription>Artifact content is rendered as text or Markdown; nothing in it can run.</DialogDescription>
          </DialogHeader>
          {open && <ArtifactContent artifactId={artifactId} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ArtifactContent({ artifactId }: { artifactId: string }) {
  const artifact = useArtifact(artifactId);
  return (
    <Panel query={artifact} skeleton={<SkeletonLines lines={5} />}>
      {(a) => (
        <div className="flex min-h-0 flex-col gap-2 text-sm" data-testid="artifact-content">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono">{a.artifact.mediaType}</span>
            <span>{bytes(a.artifact.byteSize)}</span>
            <span>{a.artifact.producer.kind === "runtime" ? `runtime · ${a.artifact.producer.component}` : "produced by an Invocation"}</span>
            <IdChip id={a.artifact.id} />
            <Button asChild size="xs" variant="outline" className="ml-auto">
              <a href={apiUrl(apiPath("downloadArtifact", { artifactId }))} download>
                <DownloadIcon />
                Download
              </a>
            </Button>
          </div>
          {a.presentation === "binary" ? <p className="text-muted-foreground">Binary content: use the download.</p> : <TextContent artifactId={artifactId} mediaType={a.artifact.mediaType} json={a.presentation === "json"} />}
        </div>
      )}
    </Panel>
  );
}

function TextContent({ artifactId, mediaType, json }: { artifactId: string; mediaType: string; json: boolean }) {
  const text = useArtifactText(artifactId);
  return (
    <Panel query={text} skeleton={<SkeletonLines lines={6} />}>
      {(t) => {
        let body = t.text;
        if (json && !t.truncated) {
          try {
            body = JSON.stringify(JSON.parse(t.text), null, 2);
          } catch {
            body = t.text;
          }
        }
        return (
          <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
            {mediaType.startsWith("text/markdown") ? (
              <div className="rounded-md border border-border p-3">
                <Markdown text={t.text} />
              </div>
            ) : (
              <CodeBlock text={body} maxHeight="60vh" />
            )}
            {t.truncated && (
              <p className="text-2xs text-muted-foreground">
                Showing the first {bytes(t.text.length)} of {bytes(t.byteSize)}; download the whole Artifact.
              </p>
            )}
          </div>
        );
      }}
    </Panel>
  );
}
