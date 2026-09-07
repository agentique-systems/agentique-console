import { Fragment } from "react";
import { ChevronRightIcon, MenuIcon, SearchIcon } from "lucide-react";
import { Link, useLocation, useMatch } from "react-router";
import type { WorkspaceResponse } from "@agentique-console/core";

import { useConversation, useRun } from "@/api/queries";
import { BrandMark } from "@/app/brand";
import { NAV_ITEMS } from "@/app/navigation";
import { ThemeToggle } from "@/app/theme-toggle";
import { ConnectionStatus } from "@/components/connection-status";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MOD_KEY } from "@/lib/hotkeys";
import { shortId } from "@/lib/format";
import { useIsDesktop } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";

/** The slim bar above the page: where you are, the palette, the live connection, and the theme. */
export function Topbar({ workspace, onOpenMenu, onOpenPalette }: { workspace: WorkspaceResponse; onOpenMenu: () => void; onOpenPalette: () => void }) {
  const desktop = useIsDesktop();
  return (
    <header data-testid="topbar" className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3 md:px-4">
      {!desktop && (
        <>
          <Button size="icon-sm" variant="ghost" onClick={onOpenMenu} aria-label="Open navigation" data-testid="open-menu">
            <MenuIcon />
          </Button>
          <BrandMark className="size-5" />
        </>
      )}
      <Breadcrumbs workspaceName={workspace.workspace.name} />
      <span className="flex-1" />
      {!desktop && (
        <Button size="icon-sm" variant="ghost" onClick={onOpenPalette} aria-label="Search and commands">
          <SearchIcon />
        </Button>
      )}
      {desktop && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={onOpenPalette} className="hidden items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground lg:flex" aria-label="Search and commands">
              <SearchIcon className="size-3.5" />
              <Kbd>{MOD_KEY}</Kbd>
              <Kbd>K</Kbd>
            </button>
          </TooltipTrigger>
          <TooltipContent>Search and commands</TooltipContent>
        </Tooltip>
      )}
      {!desktop && <ConnectionStatus compact />}
      {!desktop && <ThemeToggle />}
    </header>
  );
}

/** Where the operator is, from the route: the section, then the Conversation or Run the page is about. */
function Breadcrumbs({ workspaceName }: { workspaceName: string }) {
  const { pathname } = useLocation();
  const runMatch = useMatch("/runs/:runId/*");
  const conversationMatch = useMatch("/conversations/:conversationId");
  const section = NAV_ITEMS.find((item) => item.matches(pathname));
  const crumbs: { label: string; to?: string; mono?: boolean }[] = [];
  if (section !== undefined) crumbs.push({ label: section.label, to: section.to });
  const runId = runMatch?.params.runId;
  const conversationId = conversationMatch?.params.conversationId;
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
      <span className="hidden truncate text-muted-foreground md:inline" title={workspaceName}>
        {workspaceName}
      </span>
      {crumbs.map((crumb) => (
        <Fragment key={crumb.label}>
          <ChevronRightIcon className="hidden size-3.5 shrink-0 text-muted-foreground/60 md:inline" aria-hidden />
          {crumb.to !== undefined ? (
            <Link to={crumb.to} className={cn("truncate rounded-sm px-1 py-0.5 hover:bg-accent", runId === undefined && conversationId === undefined ? "font-medium text-foreground" : "text-muted-foreground")}>
              {crumb.label}
            </Link>
          ) : (
            <span className="truncate px-1 font-medium">{crumb.label}</span>
          )}
        </Fragment>
      ))}
      {runId !== undefined && <RunCrumb runId={runId} />}
      {conversationId !== undefined && <ConversationCrumb conversationId={conversationId} />}
    </nav>
  );
}

function RunCrumb({ runId }: { runId: string }) {
  const run = useRun(runId);
  const title = run.data?.conversation.title ?? null;
  return (
    <>
      {title !== null && run.data !== undefined && (
        <>
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
          <Link to={`/conversations/${run.data.conversation.id}`} className="hidden max-w-48 truncate rounded-sm px-1 py-0.5 text-muted-foreground hover:bg-accent sm:inline">
            {title}
          </Link>
        </>
      )}
      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
      <span className="truncate px-1 font-mono text-xs font-medium" title={runId}>
        {shortId(runId)}
      </span>
    </>
  );
}

function ConversationCrumb({ conversationId }: { conversationId: string }) {
  const conversation = useConversation(conversationId);
  return (
    <>
      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
      <span className="truncate px-1 font-medium">{conversation.data?.conversation.title ?? (conversation.data !== undefined ? "Untitled conversation" : "…")}</span>
    </>
  );
}
