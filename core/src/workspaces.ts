import { z } from "zod";
import type { WorkspaceId } from "./ids.ts";
import { idSchema, nonEmptyString, timestampSchema, type Timestamp } from "./validation.ts";

/** The Workspace provider kind: git repository or plain directory. */
export const WORKSPACE_KINDS = ["git", "directory"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export interface Workspace {
  id: WorkspaceId;
  name: string;
  rootPath: string;
  kind: WorkspaceKind;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export const workspaceSchema: z.ZodType<Workspace> = z.strictObject({
  id: idSchema("workspace"),
  name: nonEmptyString,
  rootPath: nonEmptyString,
  kind: z.enum(WORKSPACE_KINDS),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export interface WorkspaceInput {
  name: string;
  rootPath: string;
  kind: WorkspaceKind;
}

export const workspaceInputSchema: z.ZodType<WorkspaceInput> = z.strictObject({
  name: nonEmptyString,
  rootPath: nonEmptyString,
  kind: z.enum(WORKSPACE_KINDS),
});
