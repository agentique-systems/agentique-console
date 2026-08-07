import { ConversationRegion } from "@/app/conversation-region";
import { SessionDetails } from "@/app/session-details";
import { AgentPane } from "@/agents/agent-pane";
import { SessionTree } from "@/sidebar/session-tree";
import { ResizableGroup, ResizableHandle, ResizablePanel, useDefaultLayout } from "@/components/ui/resizable";
import { useScopeStore } from "@/stores/scope";

export function SessionsView() {
  const workspace = useScopeStore((s) => s.selectedWorkspaceId); const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: `agentique-console.layout:${workspace}:sessions` });
  return <ResizableGroup orientation="horizontal" className="h-full" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
    <ResizablePanel id="tree" defaultSize="240px" minSize="190px" maxSize="360px" groupResizeBehavior="preserve-pixel-size"><SessionTree allowNew /></ResizablePanel><ResizableHandle />
    <ResizablePanel id="user" minSize="320px"><ConversationRegion /></ResizablePanel><ResizableHandle />
    <ResizablePanel id="agent" defaultSize="360px" minSize="280px"><AgentPane /></ResizablePanel><ResizableHandle />
    <ResizablePanel id="details" defaultSize="300px" minSize="240px" maxSize="440px" groupResizeBehavior="preserve-pixel-size"><SessionDetails /></ResizablePanel>
  </ResizableGroup>;
}
