import { ConversationRegion } from "@/app/conversation-region";
import { SessionDetails } from "@/app/session-details";
import { AgentPane } from "@/agents/agent-pane";
import { SessionTree } from "@/sidebar/session-tree";
import { ResizableGroup, ResizableHandle, ResizablePanel, useDefaultLayout } from "@/components/ui/resizable";
import { useScopeStore } from "@/stores/scope";

export function SessionsView() {
  const workspace = useScopeStore((s) => s.selectedWorkspaceId); const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: `agentique-console.layout:${workspace}:sessions` });
  return <ResizableGroup orientation="horizontal" className="h-full" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
    <ResizablePanel id="tree" className="hidden md:block" defaultSize="260px" minSize="220px" maxSize="360px" groupResizeBehavior="preserve-pixel-size"><SessionTree allowNew /></ResizablePanel><ResizableHandle className="hidden md:flex" />
    <ResizablePanel id="user" minSize="340px"><ConversationRegion /></ResizablePanel><ResizableHandle className="hidden xl:flex" />
    <ResizablePanel id="agent" className="hidden xl:block" defaultSize="360px" minSize="300px"><AgentPane /></ResizablePanel><ResizableHandle className="hidden 2xl:flex" />
    <ResizablePanel id="details" className="hidden 2xl:block" defaultSize="300px" minSize="260px" maxSize="440px" groupResizeBehavior="preserve-pixel-size"><SessionDetails /></ResizablePanel>
  </ResizableGroup>;
}
