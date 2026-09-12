import { z } from "zod";

/** Execution identity, independent of any SDK. Omitted on pre-selection records. */
export const executionSelectionSchema = z.strictObject({
  provider: z.string().min(1).max(80).regex(/^[a-z][a-z0-9-]*$/),
  model: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
});
export type ExecutionSelection = z.infer<typeof executionSelectionSchema>;

export interface ProviderModel {
  id: string;
  label: string;
  /** Explicitly supported effort levels; empty means effort is not configurable. */
  efforts: string[];
  contextWindowTokens: number;
  availability?: { configured: boolean; detail: string };
  /** USD per million tokens. Absent means the SDK must supply cost or cost is unknown. */
  pricing?: { input: number; cacheRead: number; cacheWrite: number; output: number };
}

export type CapabilitySupport = { status: "supported" | "limited" | "unsupported"; detail: string };
export interface ProviderDescriptor {
  id: string;
  label: string;
  defaultModel: string;
  models: ProviderModel[];
  capabilities: Record<string, CapabilitySupport>;
  /** Configuration readiness, not a network authentication test. Never includes credentials. */
  availability: { configured: boolean; detail: string };
}
