import { ActivityIcon, BotIcon, MessageSquareIcon, ServerIcon, type LucideIcon } from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  Icon: LucideIcon;
  /** Whether the current path belongs to this item. */
  matches: (pathname: string) => boolean;
  hint: string;
}

/** The primary navigation, in the order an operator's day runs: what is happening, the threads, the agents, the machine. */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/runs", label: "Runs", Icon: ActivityIcon, matches: (p) => p === "/runs" || p.startsWith("/runs/"), hint: "Every Run of the Workspace, the ones needing you first" },
  { to: "/conversations", label: "Conversations", Icon: MessageSquareIcon, matches: (p) => p.startsWith("/conversations"), hint: "Your threads with the Orchestrator; Runs start here" },
  { to: "/agents", label: "Agents", Icon: BotIcon, matches: (p) => p.startsWith("/agents"), hint: "The Agent Definitions Runs execute" },
  { to: "/system", label: "System", Icon: ServerIcon, matches: (p) => p.startsWith("/system"), hint: "Health, capacity, and defaults of the console process" },
];
