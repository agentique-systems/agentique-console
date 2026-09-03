import { useState } from "react";
import { apiPath, type Artifact } from "@agentique-console/core";
import { apiUrl } from "@/api/client";
import { useArtifact, useArtifactText } from "@/api/queries";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { keys } from "@/api/keys";
import { Markdown } from "@/components/markdown";
import { Panel } from "@/components/panel";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** A link that opens an Artifact in the viewer (text and JSON inline, everything else as a download). */
export function ArtifactLink(props: { artifact?: Artifact; artifactId?: string; changesetId?: string; runId?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const changeset = useQuery({ queryKey: keys.runPart(props.runId ?? "", `changeset-${props.changesetId ?? ""}`), queryFn: () => api("getChangeset", { params: { changesetId: props.changesetId! } }), enabled: props.changesetId !== undefined });
  const artifactId = props.artifact?.id ?? props.artifactId ?? changeset.data?.diffArtifactId ?? null;
  const label = props.label ?? props.artifact?.title ?? artifactId?.slice(0, 16) ?? "artifact";
  if (artifactId === null) return <span className="text-muted-foreground">{label}</span>;
  return (
    <>
      <button type="button" className="underline decoration-dotted hover:decoration-solid" onClick={() => setOpen(true)} data-artifact={artifactId}>
        {label}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-xs">{label}</DialogTitle>
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
    <Panel query={artifact}>
      {(a) => (
        <div className="flex max-h-[70vh] flex-col gap-2 overflow-auto text-xs" data-testid="artifact-content">
          <div className="text-3xs text-muted-foreground">
            {a.artifact.mediaType} · {a.artifact.byteSize} bytes · {a.artifact.producer.kind === "runtime" ? `runtime:${a.artifact.producer.component}` : "invocation"} ·{" "}
            <a href={apiUrl(apiPath("downloadArtifact", { artifactId }))} className="underline" download>
              download
            </a>
          </div>
          {a.presentation === "binary" ? <p className="text-muted-foreground">Binary content: use the download link.</p> : <TextContent artifactId={artifactId} mediaType={a.artifact.mediaType} />}
        </div>
      )}
    </Panel>
  );
}

function TextContent({ artifactId, mediaType }: { artifactId: string; mediaType: string }) {
  const text = useArtifactText(artifactId);
  return (
    <Panel query={text}>
      {(t) => (
        <>
          {mediaType.startsWith("text/markdown") ? <Markdown text={t.text} /> : <pre className="whitespace-pre-wrap break-words rounded-md border border-border p-2 font-mono text-3xs">{t.text}</pre>}
          {t.truncated && <p className="text-3xs text-muted-foreground">Truncated at {t.text.length} characters of {t.byteSize} bytes; download the whole Artifact.</p>}
        </>
      )}
    </Panel>
  );
}
