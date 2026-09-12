import type { ExecutableRuntimeTool } from "@agentique-console/core";

/** Model-facing descriptions of the runtime tools; every executable tool has one (a new tool without one does not compile). */
export const RUNTIME_TOOL_DESCRIPTIONS: Readonly<Record<ExecutableRuntimeTool, string>> = Object.freeze({
  read_requirements: "Read the Requirements visible to this Invocation (paged, canonical tree order).",
  read_decisions: "Read the Decisions visible to this Invocation (paged).",
  read_tasks: "Read the Tasks visible to this Invocation (paged).",
  read_artifact: "Read the metadata and a bounded content range of one Artifact named in the manifest.",
  read_execution_plan: "Read the current execution plan of the Run (nodes, edges, shapes).",
  read_agent_definitions: "Read the Agent Definition revisions available to plan with.",
  write_artifact: "Create one bounded Artifact from content you supply; the runtime derives its id, digest, and size.",
  propose_tasks: "Propose a batch of Worker Tasks for this coordinator node (Coordinator decompose or replan turns).",
  update_task: "Update one Task you are permitted to update; the runtime applies the transition.",
  request_completion: "Request Run completion (root Orchestrator only); the runtime opens the completion Gate after this turn.",
  request_decision: "Request a Decision (an operator choice or a Requirement waiver); a blocking request ends this turn.",
  create_tasks: "Create Run-level Tasks for the source Execution Plan to bind (root Orchestrator only); the runtime pins Requirement scope and identity.",
  record_decision: "Record a choice you made yourself, with the options you considered and your rationale, as a resolved orchestrator_choice Decision.",
  propose_requirements: "Propose a complete Requirement tree with rationale for the operator to approve, edit, or reject; nothing changes until the operator resolves it.",
  revise_execution_plan: "Submit the complete source Execution Plan once; the runtime compiles it and records the accepted revision (then return your result and let the runtime run the nodes) or reports the typed rejection to fix.",
});


export const RETURN_RESULT_TOOL = "return_result";
export const RETURN_RESULT_DESCRIPTION = "Return the typed result of this Attempt exactly once, then stop.";
export const AGENT_INSTRUCTIONS = "Execute exactly one Agentique Attempt using the supplied manifest. Use only the supplied tools. Finish by calling return_result exactly once with the manifest's typed result. Stop immediately when a tool ends the Attempt. Operator questions go through request_decision.";
