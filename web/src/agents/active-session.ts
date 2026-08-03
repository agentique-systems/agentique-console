import { useUserSessions } from "@/api/queries";
import { useScopeStore } from "@/stores/scope";
import { useUiStore } from "@/stores/ui";

/**
 * The strip's and inspector's shared answer to "which user session is on
 * stage" — the SAME auto-land rule the conversation region applies (explicit
 * pick wins, else the most recent row), so all three columns always agree.
 * Draft posture has no session yet: both columns show their empty states.
 */
export function useActiveUserSessionId(): string | null {
  const workspaceId = useScopeStore((s) => s.selectedWorkspaceId);
  const sessions = useUserSessions(workspaceId);
  const draftOpen = useUiStore((s) => s.draftOpen);
  const activeId = useUiStore((s) => s.activeUserSessionId);

  if (draftOpen) return null;
  const rows = sessions.data ?? [];
  return rows.find((row) => row.id === activeId)?.id ?? rows[0]?.id ?? null;
}
