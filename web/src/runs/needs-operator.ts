import { useMemo } from "react";

import { itemsOf, useWorkspaceRuns } from "@/api/queries";
import { runNeedsOperator } from "@/lib/format";

/**
 * How many of the Workspace's most recent Runs need the operator now, from the
 * first page of the Run list (the page the live subscription keeps fresh).
 */
export function useNeedsOperatorCount(workspaceId: string): number {
  const runs = useWorkspaceRuns(workspaceId);
  return useMemo(() => itemsOf(runs.data, (r) => r.id).filter(runNeedsOperator).length, [runs.data]);
}
