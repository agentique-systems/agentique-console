import { ConversationRegion } from "@/app/conversation-region";
import { InspectorRegion } from "@/app/inspector-region";
import { SidebarRegion } from "@/app/sidebar-region";
import { StripRegion } from "@/app/strip-region";
import { Topbar } from "@/app/topbar";

/**
 * A full-width topbar over the four-region cockpit: sessions | conversation |
 * agent sessions | inspector. Fixed grid, no responsive collapse — the console
 * is an operator surface with a minimum viable width, not a website.
 */
export function Shell() {
  return (
    <div className="flex h-screen min-w-[1280px] flex-col overflow-hidden">
      <Topbar />
      <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(420px,5fr)_320px_minmax(340px,4fr)] overflow-hidden">
        <SidebarRegion />
        <ConversationRegion />
        <StripRegion />
        <InspectorRegion />
      </div>
    </div>
  );
}
