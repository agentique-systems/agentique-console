/**
 * Agent Definitions (execution-model §11; migration-contract §6): the
 * console's built-in set and the Workspace-file definitions read from a
 * pinned Snapshot, both as immutable revisions of the canonical store.
 */
export { BUILTIN_DEFINITION_NAMES, builtinDefinitionContents, ensureBuiltinDefinitions, type BuiltinDefinitionDefaults, type BuiltinDefinitionName } from "./builtins.ts";
export { AGENT_DEFINITION_FILE_MAX_BYTES, AGENT_DEFINITIONS_DIRECTORY, WorkspaceAgentDefinitionLoader, type AgentDefinitionLoadReport, type LoadedDefinitionFile } from "./definitions.ts";
export { evaluateNativeAgent, parseNativeAgentFile, splitFrontmatter, type EvaluatedNativeAgent, type FieldReason, type NativeAgentDefaults, type NativeAgentEvaluation, type NativeAgentParse } from "./native-agent-file.ts";
