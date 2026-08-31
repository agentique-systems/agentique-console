CREATE TABLE `acceptance_criteria` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`requirement_id` text,
	`requirement_revision_id` text,
	`task_id` text,
	`kind` text NOT NULL,
	`check` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requirement_id`) REFERENCES `requirements`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requirement_revision_id`) REFERENCES `requirement_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "acceptance_criteria_kind" CHECK("acceptance_criteria"."kind" IN ('deterministic', 'evaluated')),
	CONSTRAINT "acceptance_criteria_owner" CHECK(("acceptance_criteria"."requirement_id" IS NOT NULL) <> ("acceptance_criteria"."task_id" IS NOT NULL)),
	CONSTRAINT "acceptance_criteria_revision" CHECK(("acceptance_criteria"."requirement_id" IS NOT NULL) = ("acceptance_criteria"."requirement_revision_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `acceptance_criteria_requirement` ON `acceptance_criteria` (`requirement_id`);--> statement-breakpoint
CREATE INDEX `acceptance_criteria_task` ON `acceptance_criteria` (`task_id`);--> statement-breakpoint
CREATE TABLE `agent_definition_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`definition_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`provenance` text NOT NULL,
	`model_policy` text NOT NULL,
	`instructions` text NOT NULL,
	`capabilities` text NOT NULL,
	`tool_policy` text NOT NULL,
	`default_limits` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`definition_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_definition_revisions_hash_shape" CHECK(length("agent_definition_revisions"."content_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_definition_revisions_hash` ON `agent_definition_revisions` (`definition_id`,`content_hash`);--> statement-breakpoint
CREATE TABLE `agent_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_definitions_name_unique` ON `agent_definitions` (`name`);--> statement-breakpoint
CREATE TABLE `allocation_extensions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`plan_node_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`added_cost_usd` real NOT NULL,
	`added_tokens` integer NOT NULL,
	`added_attempts` integer NOT NULL,
	`trigger` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_node_id`) REFERENCES `plan_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reservation_id`) REFERENCES `budget_reservations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "allocation_extensions_trigger" CHECK("allocation_extensions"."trigger" IN ('invocation', 'task_batch', 'gate_evaluator', 'gate_remediation', 'root_turn', 'signoff_follow_up')),
	CONSTRAINT "allocation_extensions_non_negative" CHECK("allocation_extensions"."added_cost_usd" >= 0 AND "allocation_extensions"."added_tokens" >= 0 AND "allocation_extensions"."added_attempts" >= 0),
	CONSTRAINT "allocation_extensions_not_all_zero" CHECK("allocation_extensions"."added_cost_usd" > 0 OR "allocation_extensions"."added_tokens" > 0 OR "allocation_extensions"."added_attempts" > 0)
);
--> statement-breakpoint
CREATE INDEX `allocation_extensions_run` ON `allocation_extensions` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `allocation_extensions_plan_node` ON `allocation_extensions` (`plan_node_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `allocation_extensions_reservation` ON `allocation_extensions` (`reservation_id`);--> statement-breakpoint
CREATE TABLE `approved_tool_call_uses` (
	`id` text PRIMARY KEY NOT NULL,
	`decision_id` text NOT NULL,
	`tool` text NOT NULL,
	`call_digest` text NOT NULL,
	`run_id` text NOT NULL,
	`plan_node_id` text NOT NULL,
	`invocation_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`claimed_at` text NOT NULL,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_node_id`) REFERENCES `plan_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "approved_tool_call_uses_digest_shape" CHECK(length("approved_tool_call_uses"."call_digest") = 64),
	CONSTRAINT "approved_tool_call_uses_tool" CHECK(length("approved_tool_call_uses"."tool") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approved_tool_call_uses_decision` ON `approved_tool_call_uses` (`decision_id`);--> statement-breakpoint
CREATE INDEX `approved_tool_call_uses_invocation` ON `approved_tool_call_uses` (`invocation_id`);--> statement-breakpoint
CREATE INDEX `approved_tool_call_uses_attempt` ON `approved_tool_call_uses` (`attempt_id`);--> statement-breakpoint
CREATE INDEX `approved_tool_call_uses_run` ON `approved_tool_call_uses` (`run_id`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`digest` text NOT NULL,
	`producer` text NOT NULL,
	`invocation_id` text,
	`attempt_id` text,
	`task_id` text,
	`title` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "artifacts_byte_size" CHECK("artifacts"."byte_size" >= 0),
	CONSTRAINT "artifacts_digest_shape" CHECK(length("artifacts"."digest") = 64)
);
--> statement-breakpoint
CREATE INDEX `artifacts_run` ON `artifacts` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `artifacts_digest` ON `artifacts` (`digest`);--> statement-breakpoint
CREATE INDEX `artifacts_invocation` ON `artifacts` (`invocation_id`);--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`invocation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`plan_node_id` text NOT NULL,
	`number` integer NOT NULL,
	`kind` text NOT NULL,
	`start_mode` text NOT NULL,
	`resumed_from_attempt_id` text,
	`status` text NOT NULL,
	`failure_class` text,
	`failure_detail` text,
	`retry_decision` text,
	`retry_not_before` text,
	`transcript_artifact_id` text,
	`capacity_lease_id` text,
	`result` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	FOREIGN KEY (`invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_node_id`) REFERENCES `plan_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resumed_from_attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transcript_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`capacity_lease_id`) REFERENCES `capacity_leases`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attempts_kind" CHECK("attempts"."kind" IN ('initial', 'retry')),
	CONSTRAINT "attempts_start_mode" CHECK("attempts"."start_mode" IN ('fresh', 'resumed')),
	CONSTRAINT "attempts_status" CHECK("attempts"."status" IN ('pending', 'running', 'succeeded', 'failed', 'timed_out', 'interrupted', 'cancelled')),
	CONSTRAINT "attempts_failure_class" CHECK("attempts"."failure_class" IS NULL OR "attempts"."failure_class" IN ('provider_transient', 'provider_permanent', 'result_invalid', 'allocation_exhausted', 'interrupted', 'tool_failure', 'decision_requested')),
	CONSTRAINT "attempts_number" CHECK("attempts"."number" >= 1),
	CONSTRAINT "attempts_initial_is_first" CHECK(("attempts"."number" = 1) = ("attempts"."kind" = 'initial')),
	CONSTRAINT "attempts_resumed_from" CHECK(("attempts"."start_mode" = 'resumed') = ("attempts"."resumed_from_attempt_id" IS NOT NULL)),
	CONSTRAINT "attempts_no_self_resume" CHECK("attempts"."resumed_from_attempt_id" IS NULL OR "attempts"."resumed_from_attempt_id" <> "attempts"."id"),
	CONSTRAINT "attempts_terminal_has_ended_at" CHECK(("attempts"."status" IN ('succeeded', 'failed', 'timed_out', 'interrupted', 'cancelled')) = ("attempts"."ended_at" IS NOT NULL)),
	CONSTRAINT "attempts_succeeded_shape" CHECK("attempts"."status" <> 'succeeded' OR ("attempts"."result" IS NOT NULL AND "attempts"."failure_class" IS NULL AND "attempts"."failure_detail" IS NULL AND "attempts"."retry_decision" IS NULL)),
	CONSTRAINT "attempts_failure_classified" CHECK("attempts"."status" NOT IN ('failed', 'timed_out', 'interrupted') OR "attempts"."failure_class" IS NOT NULL),
	CONSTRAINT "attempts_retry_decision_shape" CHECK("attempts"."retry_decision" IS NULL OR ("attempts"."status" IN ('failed', 'timed_out', 'interrupted', 'cancelled') AND json_extract("attempts"."retry_decision", '$.reason') IN ('provider_transient', 'result_invalid', 'interrupted', 'tool_failure', 'provider_permanent', 'allocation_exhausted', 'attempts_exhausted', 'wall_clock_exhausted', 'cancelled', 'tool_failure_retried', 'approval_required', 'decision_requested') AND json_extract("attempts"."retry_decision", '$.permitted') IN (0, 1) AND ((json_extract("attempts"."retry_decision", '$.permitted') = 1 AND json_extract("attempts"."retry_decision", '$.reason') IN ('provider_transient', 'result_invalid', 'interrupted', 'tool_failure')) OR (json_extract("attempts"."retry_decision", '$.permitted') = 0 AND json_extract("attempts"."retry_decision", '$.notBefore') IS NULL AND json_extract("attempts"."retry_decision", '$.reason') IN ('provider_permanent', 'allocation_exhausted', 'attempts_exhausted', 'wall_clock_exhausted', 'cancelled', 'tool_failure_retried', 'approval_required', 'decision_requested'))))),
	CONSTRAINT "attempts_retry_not_before_agrees" CHECK("attempts"."retry_not_before" IS json_extract("attempts"."retry_decision", '$.notBefore')),
	CONSTRAINT "attempts_failure_detail_terminal" CHECK("attempts"."failure_detail" IS NULL OR "attempts"."status" IN ('failed', 'timed_out', 'interrupted', 'cancelled')),
	CONSTRAINT "attempts_cancelled_never_retries" CHECK("attempts"."status" <> 'cancelled' OR "attempts"."retry_decision" IS NULL OR json_extract("attempts"."retry_decision", '$.permitted') = 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_invocation_number` ON `attempts` (`invocation_id`,`number`);--> statement-breakpoint
CREATE INDEX `attempts_run_status` ON `attempts` (`run_id`,`status`);--> statement-breakpoint
CREATE INDEX `attempts_status` ON `attempts` (`status`);--> statement-breakpoint
CREATE INDEX `attempts_invocation_status` ON `attempts` (`invocation_id`,`status`,`number`);--> statement-breakpoint
CREATE INDEX `attempts_retry_not_before` ON `attempts` (`retry_not_before`);--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_active_invocation` ON `attempts` (`invocation_id`) WHERE status IN ('pending', 'running');--> statement-breakpoint
CREATE TABLE `budget_increases` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`decision_id` text NOT NULL,
	`partition` text NOT NULL,
	`added_cost_usd` real NOT NULL,
	`added_tokens` integer NOT NULL,
	`added_attempts` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "budget_increases_partition" CHECK("budget_increases"."partition" IN ('ordinary', 'final_reserve')),
	CONSTRAINT "budget_increases_non_negative" CHECK("budget_increases"."added_cost_usd" >= 0 AND "budget_increases"."added_tokens" >= 0 AND "budget_increases"."added_attempts" >= 0),
	CONSTRAINT "budget_increases_not_all_zero" CHECK("budget_increases"."added_cost_usd" > 0 OR "budget_increases"."added_tokens" > 0 OR "budget_increases"."added_attempts" > 0)
);
--> statement-breakpoint
CREATE INDEX `budget_increases_run` ON `budget_increases` (`run_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `budget_increases_decision` ON `budget_increases` (`decision_id`);--> statement-breakpoint
CREATE TABLE `budget_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`parent_type` text NOT NULL,
	`parent_id` text NOT NULL,
	`child_type` text NOT NULL,
	`child_id` text NOT NULL,
	`reserved_cost_usd` real NOT NULL,
	`reserved_tokens` integer NOT NULL,
	`reserved_attempts` integer NOT NULL,
	`consumed_cost_usd` real,
	`consumed_tokens` integer,
	`consumed_attempts` integer,
	`capacity_source` text NOT NULL,
	`final_reserve_use` text,
	`status` text NOT NULL,
	`transferred_from_reservation_id` text,
	`created_at` text NOT NULL,
	`released_at` text,
	`release_reason` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transferred_from_reservation_id`) REFERENCES `budget_reservations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "budget_reservations_parent_type" CHECK("budget_reservations"."parent_type" IN ('run', 'plan_node', 'invocation')),
	CONSTRAINT "budget_reservations_child_type" CHECK("budget_reservations"."child_type" IN ('plan_node', 'invocation', 'task')),
	CONSTRAINT "budget_reservations_pair" CHECK(("budget_reservations"."parent_type" = 'run' AND "budget_reservations"."child_type" IN ('plan_node', 'invocation')) OR ("budget_reservations"."parent_type" = 'plan_node' AND "budget_reservations"."child_type" IN ('invocation', 'task'))),
	CONSTRAINT "budget_reservations_status" CHECK("budget_reservations"."status" IN ('active', 'released')),
	CONSTRAINT "budget_reservations_capacity_source" CHECK("budget_reservations"."capacity_source" IN ('ordinary', 'final_reserve')),
	CONSTRAINT "budget_reservations_final_reserve_use" CHECK("budget_reservations"."final_reserve_use" IS NULL OR "budget_reservations"."final_reserve_use" IN ('final_synthesis', 'run_completion')),
	CONSTRAINT "budget_reservations_final_reserve_shape" CHECK(("budget_reservations"."capacity_source" = 'final_reserve') = ("budget_reservations"."final_reserve_use" IS NOT NULL)),
	CONSTRAINT "budget_reservations_final_reserve_pair" CHECK(("budget_reservations"."parent_type" = 'run' AND "budget_reservations"."child_type" = 'invocation') = ("budget_reservations"."capacity_source" = 'final_reserve')),
	CONSTRAINT "budget_reservations_final_reserve_no_transfer" CHECK("budget_reservations"."capacity_source" = 'ordinary' OR "budget_reservations"."transferred_from_reservation_id" IS NULL),
	CONSTRAINT "budget_reservations_release_reason" CHECK("budget_reservations"."release_reason" IS NULL OR "budget_reservations"."release_reason" IN ('child_terminal', 'transferred_to_invocation', 'task_cancelled', 'task_rejected', 'plan_revision_cancelled', 'run_cancelled')),
	CONSTRAINT "budget_reservations_release_shape" CHECK(("budget_reservations"."status" = 'released') = ("budget_reservations"."released_at" IS NOT NULL AND "budget_reservations"."release_reason" IS NOT NULL AND "budget_reservations"."consumed_cost_usd" IS NOT NULL AND "budget_reservations"."consumed_tokens" IS NOT NULL AND "budget_reservations"."consumed_attempts" IS NOT NULL)),
	CONSTRAINT "budget_reservations_non_negative" CHECK("budget_reservations"."reserved_cost_usd" >= 0 AND "budget_reservations"."reserved_tokens" >= 0 AND "budget_reservations"."reserved_attempts" >= 0),
	CONSTRAINT "budget_reservations_no_self_transfer" CHECK("budget_reservations"."transferred_from_reservation_id" IS NULL OR "budget_reservations"."transferred_from_reservation_id" <> "budget_reservations"."id")
);
--> statement-breakpoint
CREATE INDEX `budget_reservations_parent` ON `budget_reservations` (`parent_type`,`parent_id`,`status`);--> statement-breakpoint
CREATE INDEX `budget_reservations_child` ON `budget_reservations` (`child_type`,`child_id`);--> statement-breakpoint
CREATE INDEX `budget_reservations_run_source` ON `budget_reservations` (`run_id`,`capacity_source`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `budget_reservations_active_child` ON `budget_reservations` (`child_type`,`child_id`) WHERE status = 'active';--> statement-breakpoint
CREATE TABLE `capacity_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`resources` text NOT NULL,
	`status` text NOT NULL,
	`granted_at` text NOT NULL,
	`released_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "capacity_leases_status" CHECK("capacity_leases"."status" IN ('active', 'released')),
	CONSTRAINT "capacity_leases_released_at" CHECK(("capacity_leases"."status" = 'released') = ("capacity_leases"."released_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `capacity_leases_run_status` ON `capacity_leases` (`run_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `capacity_leases_active_attempt` ON `capacity_leases` (`attempt_id`) WHERE status = 'active';--> statement-breakpoint
CREATE TABLE `changesets` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`invocation_id` text,
	`before_snapshot_id` text NOT NULL,
	`after_snapshot_id` text NOT NULL,
	`diff_artifact_id` text NOT NULL,
	`integration_status` text NOT NULL,
	`integrated_snapshot_id` text,
	`conflict_task_id` text,
	`created_at` text NOT NULL,
	`integrated_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`before_snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`after_snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`diff_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`integrated_snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conflict_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "changesets_status" CHECK("changesets"."integration_status" IN ('pending', 'integrated', 'conflict', 'recorded')),
	CONSTRAINT "changesets_integrated_shape" CHECK(("changesets"."integration_status" = 'integrated') = ("changesets"."integrated_snapshot_id" IS NOT NULL AND "changesets"."integrated_at" IS NOT NULL)),
	CONSTRAINT "changesets_conflict_shape" CHECK(("changesets"."integration_status" = 'conflict') = ("changesets"."conflict_task_id" IS NOT NULL)),
	CONSTRAINT "changesets_kind" CHECK("changesets"."kind" IN ('invocation', 'final')),
	CONSTRAINT "changesets_kind_shape" CHECK(("changesets"."kind" = 'invocation' AND "changesets"."invocation_id" IS NOT NULL AND "changesets"."integration_status" IN ('pending', 'integrated', 'conflict')) OR ("changesets"."kind" = 'final' AND "changesets"."invocation_id" IS NULL AND "changesets"."integration_status" = 'recorded'))
);
--> statement-breakpoint
CREATE INDEX `changesets_run` ON `changesets` (`run_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `changesets_final_run` ON `changesets` (`run_id`) WHERE kind = 'final';--> statement-breakpoint
CREATE TABLE `completion_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`invocation_id` text NOT NULL,
	`runtime_tool_call_id` text NOT NULL,
	`status` text NOT NULL,
	`gate_id` text,
	`report_artifact_id` text,
	`outcome` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`runtime_tool_call_id`) REFERENCES `runtime_tool_calls`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`gate_id`) REFERENCES `gates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`report_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "completion_requests_status" CHECK("completion_requests"."status" IN ('requested', 'verifying', 'passed', 'failed', 'cancelled')),
	CONSTRAINT "completion_requests_gate_shape" CHECK(("completion_requests"."status" IN ('verifying', 'passed', 'failed')) = ("completion_requests"."gate_id" IS NOT NULL)),
	CONSTRAINT "completion_requests_started_shape" CHECK(("completion_requests"."status" IN ('verifying', 'passed', 'failed')) = ("completion_requests"."started_at" IS NOT NULL)),
	CONSTRAINT "completion_requests_report_shape" CHECK(("completion_requests"."status" = 'passed') = ("completion_requests"."report_artifact_id" IS NOT NULL)),
	CONSTRAINT "completion_requests_outcome_shape" CHECK(("completion_requests"."status" IN ('failed', 'cancelled')) = ("completion_requests"."outcome" IS NOT NULL)),
	CONSTRAINT "completion_requests_terminal_has_ended_at" CHECK(("completion_requests"."status" IN ('passed', 'failed', 'cancelled')) = ("completion_requests"."ended_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `completion_requests_run` ON `completion_requests` (`run_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `completion_requests_active_run` ON `completion_requests` (`run_id`) WHERE status IN ('requested', 'verifying');--> statement-breakpoint
CREATE UNIQUE INDEX `completion_requests_call` ON `completion_requests` (`runtime_tool_call_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `completion_requests_invocation` ON `completion_requests` (`invocation_id`);--> statement-breakpoint
CREATE TABLE `context_manifests` (
	`id` text PRIMARY KEY NOT NULL,
	`invocation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`content` text NOT NULL,
	`digest` text NOT NULL,
	`renderer_version` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "context_manifests_digest_shape" CHECK(length("context_manifests"."digest") = 64),
	CONSTRAINT "context_manifests_renderer_version" CHECK("context_manifests"."renderer_version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `context_manifests_invocation_id_unique` ON `context_manifests` (`invocation_id`);--> statement-breakpoint
CREATE TABLE `conversation_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text,
	`invocation_id` text,
	`author` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversation_messages_author" CHECK("conversation_messages"."author" IN ('operator', 'orchestrator')),
	CONSTRAINT "conversation_messages_invocation" CHECK("conversation_messages"."author" = 'orchestrator' OR "conversation_messages"."invocation_id" IS NULL)
);
--> statement-breakpoint
CREATE INDEX `conversation_messages_conversation` ON `conversation_messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text,
	`active_run_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`active_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversations_workspace` ON `conversations` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text,
	`kind` text NOT NULL,
	`resolution_policy` text NOT NULL,
	`status` text NOT NULL,
	`requested_by` text NOT NULL,
	`question` text NOT NULL,
	`options` text NOT NULL,
	`recommended_option_id` text,
	`rationale` text,
	`affects` text NOT NULL,
	`deadline_at` text,
	`activation_condition` text,
	`subject` text,
	`resolved_by` text,
	`chosen_option_id` text,
	`resolution_rationale` text,
	`resolution_artifact_ids` text,
	`resolved_at` text,
	`supersedes_decision_id` text,
	`superseded_by_decision_id` text,
	`supersession_reason` text,
	`created_at` text NOT NULL,
	`subject_gate_id` text GENERATED ALWAYS AS (json_extract(subject, '$.gateId')) VIRTUAL,
	`requester_invocation_id` text GENERATED ALWAYS AS (json_extract(requested_by, '$.invocationId')) VIRTUAL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supersedes_decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`superseded_by_decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "decisions_kind" CHECK("decisions"."kind" IN ('operator_choice', 'orchestrator_choice', 'requirement_waiver', 'side_effect_approval', 'signoff', 'publish', 'budget_increase')),
	CONSTRAINT "decisions_policy" CHECK("decisions"."resolution_policy" IN ('operator_required', 'use_default_after_deadline')),
	CONSTRAINT "decisions_status" CHECK("decisions"."status" IN ('open', 'resolved', 'superseded')),
	CONSTRAINT "decisions_resolver" CHECK("decisions"."resolved_by" IS NULL OR "decisions"."resolved_by" IN ('operator', 'orchestrator', 'policy:use_default_after_deadline')),
	CONSTRAINT "decisions_waiver_operator_required" CHECK("decisions"."kind" <> 'requirement_waiver' OR "decisions"."resolution_policy" = 'operator_required'),
	CONSTRAINT "decisions_operator_only_kinds" CHECK("decisions"."kind" NOT IN ('requirement_waiver', 'side_effect_approval', 'signoff', 'publish', 'budget_increase') OR "decisions"."resolved_by" IS NULL OR "decisions"."resolved_by" = 'operator'),
	CONSTRAINT "decisions_budget_increase_shape" CHECK("decisions"."kind" <> 'budget_increase' OR (json_extract("decisions"."subject", '$.partition') IN ('ordinary', 'final_reserve') AND json_extract("decisions"."subject", '$.added.costUsd') >= 0 AND json_extract("decisions"."subject", '$.added.tokens') >= 0 AND json_extract("decisions"."subject", '$.added.attempts') >= 0 AND (json_extract("decisions"."subject", '$.added.costUsd') > 0 OR json_extract("decisions"."subject", '$.added.tokens') > 0 OR json_extract("decisions"."subject", '$.added.attempts') > 0) AND "decisions"."deadline_at" IS NULL AND "decisions"."activation_condition" IS NULL)),
	CONSTRAINT "decisions_default_policy_shape" CHECK("decisions"."resolution_policy" <> 'use_default_after_deadline' OR ("decisions"."kind" = 'operator_choice' AND "decisions"."recommended_option_id" IS NOT NULL AND "decisions"."rationale" IS NOT NULL AND ("decisions"."deadline_at" IS NOT NULL OR "decisions"."activation_condition" IS NOT NULL))),
	CONSTRAINT "decisions_policy_resolver" CHECK("decisions"."resolved_by" IS NULL OR "decisions"."resolved_by" <> 'policy:use_default_after_deadline' OR ("decisions"."resolution_policy" = 'use_default_after_deadline' AND "decisions"."chosen_option_id" = "decisions"."recommended_option_id")),
	CONSTRAINT "decisions_resolution_shape" CHECK(("decisions"."status" = 'open' AND "decisions"."resolved_by" IS NULL AND "decisions"."chosen_option_id" IS NULL AND "decisions"."resolved_at" IS NULL) OR ("decisions"."status" = 'resolved' AND "decisions"."resolved_by" IS NOT NULL AND "decisions"."chosen_option_id" IS NOT NULL AND "decisions"."resolved_at" IS NOT NULL) OR "decisions"."status" = 'superseded'),
	CONSTRAINT "decisions_superseded_reason" CHECK(("decisions"."status" = 'superseded') = ("decisions"."supersession_reason" IS NOT NULL)),
	CONSTRAINT "decisions_supersession_reason" CHECK("decisions"."supersession_reason" IS NULL OR "decisions"."supersession_reason" IN ('superseding_decision', 'requirement_waiver_stale')),
	CONSTRAINT "decisions_superseded_by" CHECK(("decisions"."supersession_reason" IS 'superseding_decision') = ("decisions"."superseded_by_decision_id" IS NOT NULL)),
	CONSTRAINT "decisions_stale_waiver_only" CHECK("decisions"."supersession_reason" IS NOT 'requirement_waiver_stale' OR "decisions"."kind" = 'requirement_waiver'),
	CONSTRAINT "decisions_subject_shape" CHECK(("decisions"."kind" IN ('side_effect_approval', 'signoff', 'publish', 'budget_increase', 'requirement_waiver')) = ("decisions"."subject" IS NOT NULL AND json_extract("decisions"."subject", '$.kind') = "decisions"."kind" AND "decisions"."run_id" IS NOT NULL)),
	CONSTRAINT "decisions_signoff_policy" CHECK("decisions"."kind" NOT IN ('signoff', 'publish', 'budget_increase', 'requirement_waiver') OR ("decisions"."resolution_policy" = 'operator_required' AND json_extract("decisions"."subject", '$.runId') = "decisions"."run_id")),
	CONSTRAINT "decisions_waiver_subject_shape" CHECK("decisions"."kind" <> 'requirement_waiver' OR (json_extract("decisions"."subject", '$.requirementId') GLOB 'req_*' AND json_extract("decisions"."subject", '$.requirementRevisionId') GLOB 'reqr_*' AND json_type("decisions"."subject", '$.evidenceArtifactIds') = 'array' AND json_array_length("decisions"."subject", '$.evidenceArtifactIds') <= 20 AND json_array_length("decisions"."affects", '$.requirementIds') = 1 AND json_extract("decisions"."affects", '$.requirementIds[0]') = json_extract("decisions"."subject", '$.requirementId'))),
	CONSTRAINT "decisions_requestable_by_invocation" CHECK(json_extract("decisions"."requested_by", '$.kind') <> 'invocation' OR "decisions"."kind" IN ('operator_choice', 'requirement_waiver', 'side_effect_approval')),
	CONSTRAINT "decisions_no_self_supersede" CHECK("decisions"."supersedes_decision_id" IS NULL OR "decisions"."supersedes_decision_id" <> "decisions"."id")
);
--> statement-breakpoint
CREATE INDEX `decisions_conversation_status` ON `decisions` (`conversation_id`,`status`);--> statement-breakpoint
CREATE INDEX `decisions_run` ON `decisions` (`run_id`);--> statement-breakpoint
CREATE INDEX `decisions_requester_invocation` ON `decisions` (`requester_invocation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_signoff_gate` ON `decisions` (`subject_gate_id`) WHERE kind = 'signoff';--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_open_publish_run` ON `decisions` (`run_id`) WHERE kind = 'publish' AND status = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_open_budget_increase_run` ON `decisions` (`run_id`) WHERE kind = 'budget_increase' AND status = 'open';--> statement-breakpoint
CREATE TABLE `evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`plan_node_id` text,
	`gate_id` text,
	`subject` text NOT NULL,
	`context` text,
	`verdict` text NOT NULL,
	`evidence` text NOT NULL,
	`produced_by` text NOT NULL,
	`artifact_ids` text NOT NULL,
	`snapshot_id` text,
	`created_at` text NOT NULL,
	`context_kind` text GENERATED ALWAYS AS (json_extract(context, '$.kind')) VIRTUAL,
	`context_round` integer GENERATED ALWAYS AS (json_extract(context, '$.round')) VIRTUAL,
	`context_publication_id` text GENERATED ALWAYS AS (json_extract(context, '$.publicationId')) VIRTUAL,
	`subject_criterion_id` text GENERATED ALWAYS AS (json_extract(subject, '$.acceptanceCriterionId')) VIRTUAL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_node_id`) REFERENCES `plan_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`gate_id`) REFERENCES `gates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "evaluations_verdict" CHECK("evaluations"."verdict" IN ('pass', 'fail', 'inconclusive')),
	CONSTRAINT "evaluations_route_selection_shape" CHECK(json_extract("evaluations"."subject", '$.kind') <> 'route_selection' OR ("evaluations"."plan_node_id" IS NOT NULL AND "evaluations"."gate_id" IS NULL AND "evaluations"."context" IS NULL AND "evaluations"."verdict" = 'pass' AND json_extract("evaluations"."subject", '$.selectedLabel') IS NOT NULL)),
	CONSTRAINT "evaluations_optimizer_shape" CHECK("evaluations"."context" IS NULL OR json_extract("evaluations"."context", '$.kind') = 'publication' OR ("evaluations"."plan_node_id" IS NOT NULL AND "evaluations"."gate_id" IS NULL AND "evaluations"."snapshot_id" IS NOT NULL AND json_extract("evaluations"."context", '$.round') >= 1 AND json_extract("evaluations"."context", '$.round') <= json_extract("evaluations"."context", '$.maxRounds') AND ((json_extract("evaluations"."context", '$.kind') = 'optimizer_verdict' AND json_extract("evaluations"."subject", '$.kind') = 'optimizer_round') OR (json_extract("evaluations"."context", '$.kind') = 'optimizer_criterion' AND json_extract("evaluations"."subject", '$.kind') = 'acceptance_criterion')))),
	CONSTRAINT "evaluations_publication_shape" CHECK("evaluations"."context_kind" IS NOT 'publication' OR ("evaluations"."plan_node_id" IS NULL AND "evaluations"."gate_id" IS NULL AND "evaluations"."snapshot_id" IS NOT NULL AND json_extract("evaluations"."subject", '$.kind') = 'acceptance_criterion' AND json_extract("evaluations"."produced_by", '$.kind') = 'runtime')),
	CONSTRAINT "evaluations_optimizer_round_subject" CHECK(json_extract("evaluations"."subject", '$.kind') <> 'optimizer_round' OR json_extract("evaluations"."context", '$.kind') = 'optimizer_verdict'),
	CONSTRAINT "evaluations_gate_shape" CHECK("evaluations"."gate_id" IS NULL OR "evaluations"."context" IS NULL)
);
--> statement-breakpoint
CREATE INDEX `evaluations_run` ON `evaluations` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `evaluations_gate` ON `evaluations` (`gate_id`);--> statement-breakpoint
CREATE INDEX `evaluations_plan_node` ON `evaluations` (`plan_node_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `evaluations_route_selection_node` ON `evaluations` (`plan_node_id`) WHERE json_extract(subject, '$.kind') = 'route_selection';--> statement-breakpoint
CREATE UNIQUE INDEX `evaluations_optimizer_verdict_round` ON `evaluations` (`plan_node_id`,`context_round`) WHERE context_kind = 'optimizer_verdict';--> statement-breakpoint
CREATE UNIQUE INDEX `evaluations_optimizer_criterion_round` ON `evaluations` (`plan_node_id`,`context_round`,`subject_criterion_id`) WHERE context_kind = 'optimizer_criterion';--> statement-breakpoint
CREATE UNIQUE INDEX `evaluations_publication_criterion` ON `evaluations` (`context_publication_id`,`subject_criterion_id`) WHERE context_kind = 'publication';--> statement-breakpoint
CREATE UNIQUE INDEX `evaluations_gate_criterion` ON `evaluations` (`gate_id`,`subject_criterion_id`) WHERE gate_id IS NOT NULL AND subject_criterion_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`occurred_at` text NOT NULL,
	`workspace_id` text,
	`conversation_id` text,
	`run_id` text,
	`plan_node_id` text,
	`invocation_id` text,
	`attempt_id` text,
	`actor` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`payload` text NOT NULL,
	`correlation_id` text,
	`causation_seq` integer,
	FOREIGN KEY (`causation_seq`) REFERENCES `events`(`seq`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "events_scope" CHECK("events"."workspace_id" IS NOT NULL OR "events"."conversation_id" IS NOT NULL OR "events"."run_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `events_run` ON `events` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_conversation` ON `events` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_workspace` ON `events` (`workspace_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_type` ON `events` (`type`,`seq`);--> statement-breakpoint
CREATE TABLE `execution_plan_revisions` (
	`run_id` text NOT NULL,
	`number` integer NOT NULL,
	`source` text NOT NULL,
	`proposed_by_invocation_id` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `number`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proposed_by_invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "execution_plan_revisions_number" CHECK("execution_plan_revisions"."number" >= 1)
);
--> statement-breakpoint
CREATE TABLE `gates` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`plan_node_id` text,
	`kind` text NOT NULL,
	`ordinal` integer NOT NULL,
	`status` text NOT NULL,
	`acceptance_criterion_ids` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`candidate_artifact_ids` text NOT NULL,
	`completion_request_id` text,
	`requirement_revision_id` text,
	`requirement_ids` text NOT NULL,
	`completion_gate_id` text,
	`report_artifact_id` text,
	`failure` text,
	`opened_at` text NOT NULL,
	`closed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_node_id`) REFERENCES `plan_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`completion_request_id`) REFERENCES `completion_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requirement_revision_id`) REFERENCES `requirement_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`completion_gate_id`) REFERENCES `gates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`report_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "gates_kind" CHECK("gates"."kind" IN ('node_exit', 'run_completion', 'operator_signoff')),
	CONSTRAINT "gates_status" CHECK("gates"."status" IN ('open', 'passed', 'failed')),
	CONSTRAINT "gates_node_exit_has_node" CHECK(("gates"."kind" = 'node_exit') = ("gates"."plan_node_id" IS NOT NULL)),
	CONSTRAINT "gates_ordinal" CHECK("gates"."ordinal" >= 1),
	CONSTRAINT "gates_closed_at" CHECK(("gates"."status" = 'open') = ("gates"."closed_at" IS NULL)),
	CONSTRAINT "gates_failed_has_failure" CHECK(("gates"."status" = 'failed') = ("gates"."failure" IS NOT NULL)),
	CONSTRAINT "gates_failure_kind" CHECK("gates"."failure" IS NULL OR json_extract("gates"."failure", '$.kind') IN ('criteria_failed', 'evaluator_failed', 'conditions_unmet', 'final_synthesis_failed', 'final_reserve_exhausted', 'changes_requested')),
	CONSTRAINT "gates_failure_by_kind" CHECK("gates"."failure" IS NULL OR ("gates"."kind" = 'node_exit' AND json_extract("gates"."failure", '$.kind') IN ('criteria_failed', 'evaluator_failed')) OR ("gates"."kind" = 'run_completion' AND json_extract("gates"."failure", '$.kind') IN ('criteria_failed', 'evaluator_failed', 'conditions_unmet', 'final_synthesis_failed', 'final_reserve_exhausted')) OR ("gates"."kind" = 'operator_signoff' AND json_extract("gates"."failure", '$.kind') = 'changes_requested')),
	CONSTRAINT "gates_run_gate_identity" CHECK(("gates"."kind" <> 'node_exit') = ("gates"."completion_request_id" IS NOT NULL AND "gates"."requirement_revision_id" IS NOT NULL)),
	CONSTRAINT "gates_node_exit_no_requirements" CHECK("gates"."kind" <> 'node_exit' OR "gates"."requirement_ids" = '[]'),
	CONSTRAINT "gates_signoff_shape" CHECK(("gates"."kind" = 'operator_signoff') = ("gates"."completion_gate_id" IS NOT NULL)),
	CONSTRAINT "gates_signoff_criteria" CHECK("gates"."kind" <> 'operator_signoff' OR "gates"."acceptance_criterion_ids" = '[]'),
	CONSTRAINT "gates_no_self_presentation" CHECK("gates"."completion_gate_id" IS NULL OR "gates"."completion_gate_id" <> "gates"."id"),
	CONSTRAINT "gates_report_shape" CHECK(("gates"."kind" = 'operator_signoff' AND "gates"."report_artifact_id" IS NOT NULL) OR ("gates"."kind" = 'run_completion' AND (("gates"."status" = 'passed') = ("gates"."report_artifact_id" IS NOT NULL))) OR ("gates"."kind" = 'node_exit' AND "gates"."report_artifact_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `gates_run` ON `gates` (`run_id`,`kind`,`status`);--> statement-breakpoint
CREATE INDEX `gates_plan_node` ON `gates` (`plan_node_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `gates_completion_request` ON `gates` (`completion_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `gates_open_node_exit` ON `gates` (`plan_node_id`) WHERE kind = 'node_exit' AND status = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX `gates_node_exit_ordinal` ON `gates` (`plan_node_id`,`ordinal`) WHERE kind = 'node_exit';--> statement-breakpoint
CREATE UNIQUE INDEX `gates_open_run_gate` ON `gates` (`run_id`,`kind`) WHERE plan_node_id IS NULL AND status = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX `gates_run_gate_ordinal` ON `gates` (`run_id`,`kind`,`ordinal`) WHERE plan_node_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `gates_completion_request_kind` ON `gates` (`completion_request_id`,`kind`) WHERE completion_request_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`handoff_key` text NOT NULL,
	`source` text NOT NULL,
	`target` text NOT NULL,
	`task_ids` text NOT NULL,
	`artifact_ids` text NOT NULL,
	`summary` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`delivered_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "handoffs_key_shape" CHECK("handoffs"."handoff_key" GLOB 'sequence:pn_*:pn_*' OR "handoffs"."handoff_key" GLOB 'chain_step:pn_*:[0-9]*' OR "handoffs"."handoff_key" GLOB 'branch:pn_*:pn_*' OR "handoffs"."handoff_key" GLOB 'parallel_index:pn_*' OR "handoffs"."handoff_key" GLOB 'worker_result:pn_*:task_*' OR "handoffs"."handoff_key" GLOB 'retry:pn_*:pn_*' OR "handoffs"."handoff_key" GLOB 'optimizer_candidate:pn_*:[0-9]*' OR "handoffs"."handoff_key" GLOB 'optimizer_feedback:pn_*:[0-9]*'),
	CONSTRAINT "handoffs_status" CHECK("handoffs"."status" IN ('pending', 'delivered', 'cancelled')),
	CONSTRAINT "handoffs_summary_length" CHECK(length("handoffs"."summary") <= 500),
	CONSTRAINT "handoffs_delivered_at" CHECK(("handoffs"."status" = 'delivered') = ("handoffs"."delivered_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `handoffs_run` ON `handoffs` (`run_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `handoffs_run_key` ON `handoffs` (`run_id`,`handoff_key`);--> statement-breakpoint
CREATE TABLE `invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`plan_node_id` text NOT NULL,
	`role` text NOT NULL,
	`purpose` text NOT NULL,
	`agent_definition_revision_id` text NOT NULL,
	`continued_from_invocation_id` text,
	`pattern_position` text,
	`pattern_position_key` text,
	`gate_id` text,
	`task_ids` text NOT NULL,
	`alloc_cost_usd` real NOT NULL,
	`alloc_tokens` integer NOT NULL,
	`alloc_attempts` integer NOT NULL,
	`allocation_source` text NOT NULL,
	`final_reserve_use` text,
	`status` text NOT NULL,
	`wait_reason` text,
	`failure_reason` text,
	`blocked_by_decision_id` text,
	`result` text,
	`workspace_cleanup` text DEFAULT 'none' NOT NULL,
	`workspace_released_at` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_node_id`) REFERENCES `plan_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_definition_revision_id`) REFERENCES `agent_definition_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`continued_from_invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`gate_id`) REFERENCES `gates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`blocked_by_decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invocations_workspace_cleanup" CHECK("invocations"."workspace_cleanup" IN ('none', 'pending', 'released')),
	CONSTRAINT "invocations_workspace_released_at" CHECK(("invocations"."workspace_cleanup" = 'released') = ("invocations"."workspace_released_at" IS NOT NULL)),
	CONSTRAINT "invocations_role" CHECK("invocations"."role" IN ('orchestrator', 'worker', 'coordinator', 'evaluator')),
	CONSTRAINT "invocations_allocation_source" CHECK("invocations"."allocation_source" IN ('plan_node', 'run_final_reserve')),
	CONSTRAINT "invocations_final_reserve_use" CHECK("invocations"."final_reserve_use" IS NULL OR "invocations"."final_reserve_use" IN ('final_synthesis', 'run_completion')),
	CONSTRAINT "invocations_final_reserve_shape" CHECK(("invocations"."allocation_source" = 'run_final_reserve') = ("invocations"."final_reserve_use" IS NOT NULL)),
	CONSTRAINT "invocations_final_reserve_binding" CHECK("invocations"."final_reserve_use" IS NULL OR ("invocations"."final_reserve_use" = 'final_synthesis' AND "invocations"."role" = 'orchestrator' AND "invocations"."purpose" = 'final_synthesis') OR ("invocations"."final_reserve_use" = 'run_completion' AND "invocations"."role" = 'evaluator' AND "invocations"."purpose" = 'evaluate')),
	CONSTRAINT "invocations_final_reserve_no_tasks" CHECK("invocations"."allocation_source" = 'plan_node' OR "invocations"."task_ids" = '[]'),
	CONSTRAINT "invocations_purpose" CHECK("invocations"."purpose" IN ('operator_input', 'plan_revision', 'node_result', 'decision_resolution', 'gate_result', 'final_synthesis', 'step', 'task', 'select', 'evaluate', 'decompose', 'replan', 'synthesize')),
	CONSTRAINT "invocations_role_purpose" CHECK((role = 'orchestrator' AND purpose IN ('operator_input', 'plan_revision', 'node_result', 'decision_resolution', 'gate_result', 'final_synthesis')) OR (role = 'worker' AND purpose IN ('step', 'task')) OR (role = 'evaluator' AND purpose IN ('select', 'evaluate')) OR (role = 'coordinator' AND purpose IN ('decompose', 'replan', 'synthesize'))),
	CONSTRAINT "invocations_status" CHECK("invocations"."status" IN ('pending', 'running', 'waiting', 'blocked', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "invocations_wait_reason" CHECK("invocations"."wait_reason" IS NULL OR "invocations"."wait_reason" IN ('decision', 'budget', 'provider_capacity', 'operator')),
	CONSTRAINT "invocations_failure_reason" CHECK("invocations"."failure_reason" IS NULL OR "invocations"."failure_reason" IN ('attempts_exhausted', 'provider_permanent', 'allocation_exhausted', 'result_invalid', 'cancelled')),
	CONSTRAINT "invocations_waiting_has_reason" CHECK(("invocations"."status" = 'waiting') = ("invocations"."wait_reason" IS NOT NULL)),
	CONSTRAINT "invocations_failed_has_reason" CHECK(("invocations"."status" = 'failed') = ("invocations"."failure_reason" IS NOT NULL)),
	CONSTRAINT "invocations_blocked_has_decision" CHECK(("invocations"."status" = 'blocked') = ("invocations"."blocked_by_decision_id" IS NOT NULL)),
	CONSTRAINT "invocations_terminal_has_ended_at" CHECK(("invocations"."status" IN ('blocked', 'succeeded', 'failed', 'cancelled')) = ("invocations"."ended_at" IS NOT NULL)),
	CONSTRAINT "invocations_alloc_attempts" CHECK("invocations"."alloc_attempts" >= 1 AND "invocations"."alloc_cost_usd" >= 0 AND "invocations"."alloc_tokens" >= 0),
	CONSTRAINT "invocations_no_self_continue" CHECK("invocations"."continued_from_invocation_id" IS NULL OR "invocations"."continued_from_invocation_id" <> "invocations"."id"),
	CONSTRAINT "invocations_pattern_position_kind" CHECK("invocations"."pattern_position" IS NULL OR json_extract("invocations"."pattern_position", '$.kind') IN ('orchestrator', 'single', 'chain_step', 'route_selection', 'route_branch', 'parallel_item', 'parallel_aggregation', 'coordinator_turn', 'worker_task', 'producer_round', 'evaluator_round')),
	CONSTRAINT "invocations_pattern_position_present" CHECK("invocations"."pattern_position" IS NOT NULL OR ("invocations"."role" = 'evaluator' AND "invocations"."purpose" = 'evaluate')),
	CONSTRAINT "invocations_gate_ownership" CHECK("invocations"."purpose" = 'final_synthesis' OR (("invocations"."pattern_position" IS NULL) = ("invocations"."gate_id" IS NOT NULL))),
	CONSTRAINT "invocations_final_synthesis_gate" CHECK("invocations"."purpose" <> 'final_synthesis' OR "invocations"."gate_id" IS NOT NULL),
	CONSTRAINT "invocations_gate_evaluator_role" CHECK("invocations"."gate_id" IS NULL OR ((("invocations"."role" = 'evaluator' AND "invocations"."purpose" = 'evaluate') OR ("invocations"."role" = 'orchestrator' AND "invocations"."purpose" = 'final_synthesis')) AND "invocations"."task_ids" = '[]')),
	CONSTRAINT "invocations_pattern_position_key_agrees" CHECK(("invocations"."pattern_position" IS NULL AND "invocations"."pattern_position_key" IS NULL) OR "invocations"."pattern_position_key" = (json_extract("invocations"."pattern_position", '$.kind') || CASE WHEN json_extract("invocations"."pattern_position", '$.index') IS NOT NULL THEN ':' || json_extract("invocations"."pattern_position", '$.index') WHEN json_extract("invocations"."pattern_position", '$.round') IS NOT NULL THEN ':' || json_extract("invocations"."pattern_position", '$.round') WHEN json_extract("invocations"."pattern_position", '$.label') IS NOT NULL THEN ':' || json_extract("invocations"."pattern_position", '$.label') WHEN json_extract("invocations"."pattern_position", '$.taskId') IS NOT NULL THEN ':' || json_extract("invocations"."pattern_position", '$.taskId') ELSE '' END)),
	CONSTRAINT "invocations_pattern_position_role" CHECK("invocations"."pattern_position" IS NULL OR (json_extract("invocations"."pattern_position", '$.kind') = 'orchestrator' AND "invocations"."role" = 'orchestrator') OR (json_extract("invocations"."pattern_position", '$.kind') IN ('single', 'chain_step', 'route_branch', 'parallel_item', 'parallel_aggregation', 'producer_round') AND "invocations"."role" = 'worker' AND "invocations"."purpose" = 'step') OR (json_extract("invocations"."pattern_position", '$.kind') = 'worker_task' AND "invocations"."role" = 'worker' AND "invocations"."purpose" = 'task') OR (json_extract("invocations"."pattern_position", '$.kind') = 'route_selection' AND "invocations"."role" = 'evaluator' AND "invocations"."purpose" = 'select') OR (json_extract("invocations"."pattern_position", '$.kind') = 'evaluator_round' AND "invocations"."role" = 'evaluator' AND "invocations"."purpose" = 'evaluate') OR (json_extract("invocations"."pattern_position", '$.kind') = 'coordinator_turn' AND "invocations"."role" = 'coordinator'))
);
--> statement-breakpoint
CREATE INDEX `invocations_plan_node_status` ON `invocations` (`plan_node_id`,`status`);--> statement-breakpoint
CREATE INDEX `invocations_workspace_cleanup_pending` ON `invocations` (`run_id`,`status`) WHERE workspace_cleanup = 'pending';--> statement-breakpoint
CREATE INDEX `invocations_run_status` ON `invocations` (`run_id`,`status`);--> statement-breakpoint
CREATE INDEX `invocations_plan_node_source` ON `invocations` (`plan_node_id`,`allocation_source`);--> statement-breakpoint
CREATE INDEX `invocations_plan_node_position` ON `invocations` (`plan_node_id`,`pattern_position_key`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `invocations_active_gate` ON `invocations` (`gate_id`) WHERE gate_id IS NOT NULL AND role = 'evaluator' AND status IN ('pending', 'running', 'waiting');--> statement-breakpoint
CREATE UNIQUE INDEX `invocations_active_synthesis` ON `invocations` (`gate_id`) WHERE gate_id IS NOT NULL AND purpose = 'final_synthesis' AND status IN ('pending', 'running', 'waiting');--> statement-breakpoint
CREATE INDEX `invocations_gate` ON `invocations` (`gate_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invocations_active_position` ON `invocations` (`plan_node_id`,`pattern_position_key`) WHERE pattern_position_key IS NOT NULL AND status IN ('pending', 'running', 'waiting');--> statement-breakpoint
CREATE UNIQUE INDEX `invocations_active_orchestrator` ON `invocations` (`run_id`) WHERE role = 'orchestrator' AND status IN ('pending', 'running', 'waiting');--> statement-breakpoint
CREATE UNIQUE INDEX `invocations_active_coordinator` ON `invocations` (`plan_node_id`) WHERE role = 'coordinator' AND status IN ('pending', 'running', 'waiting');--> statement-breakpoint
CREATE TABLE `plan_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`source_node_id` text NOT NULL,
	`target_node_id` text NOT NULL,
	`type` text NOT NULL,
	`label` text,
	`round` integer,
	`position` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_node_id`) REFERENCES `plan_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_node_id`) REFERENCES `plan_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`,`revision_number`) REFERENCES `execution_plan_revisions`(`run_id`,`number`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "plan_edges_type" CHECK("plan_edges"."type" IN ('sequence', 'branch', 'fan_in', 'retry')),
	CONSTRAINT "plan_edges_no_self_loop" CHECK("plan_edges"."source_node_id" <> "plan_edges"."target_node_id"),
	CONSTRAINT "plan_edges_branch_label" CHECK(("plan_edges"."type" = 'branch') = ("plan_edges"."label" IS NOT NULL)),
	CONSTRAINT "plan_edges_retry_round" CHECK(("plan_edges"."type" = 'retry') = ("plan_edges"."round" IS NOT NULL)),
	CONSTRAINT "plan_edges_round_min" CHECK("plan_edges"."round" IS NULL OR "plan_edges"."round" >= 2),
	CONSTRAINT "plan_edges_position" CHECK("plan_edges"."position" >= 0)
);
--> statement-breakpoint
CREATE INDEX `plan_edges_revision` ON `plan_edges` (`run_id`,`revision_number`,`target_node_id`,`position`);--> statement-breakpoint
CREATE INDEX `plan_edges_source` ON `plan_edges` (`source_node_id`);--> statement-breakpoint
CREATE INDEX `plan_edges_target` ON `plan_edges` (`target_node_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `plan_edges_unique` ON `plan_edges` (`run_id`,`revision_number`,`source_node_id`,`target_node_id`,`type`,`label`,`round`);--> statement-breakpoint
CREATE UNIQUE INDEX `plan_edges_target_position` ON `plan_edges` (`run_id`,`revision_number`,`target_node_id`,`position`);--> statement-breakpoint
CREATE TABLE `plan_node_requirements` (
	`plan_node_id` text NOT NULL,
	`run_id` text NOT NULL,
	`requirement_id` text NOT NULL,
	`requirement_revision_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`plan_node_id`, `requirement_id`, `requirement_revision_id`),
	FOREIGN KEY (`plan_node_id`) REFERENCES `plan_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requirement_id`) REFERENCES `requirements`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requirement_revision_id`) REFERENCES `requirement_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "plan_node_requirements_position" CHECK("plan_node_requirements"."position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_node_requirements_position` ON `plan_node_requirements` (`plan_node_id`,`position`);--> statement-breakpoint
CREATE INDEX `plan_node_requirements_requirement` ON `plan_node_requirements` (`requirement_id`,`requirement_revision_id`);--> statement-breakpoint
CREATE TABLE `plan_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`created_in_revision_number` integer NOT NULL,
	`kind` text NOT NULL,
	`pattern` text,
	`title` text NOT NULL,
	`source_path` text NOT NULL,
	`status` text NOT NULL,
	`wait_reason` text,
	`fan_in_policy` text,
	`input` text,
	`shape` text,
	`alloc_cost_usd` real NOT NULL,
	`alloc_tokens` integer NOT NULL,
	`alloc_attempts` integer NOT NULL,
	`max_concurrency` integer,
	`max_wall_clock_ms` integer,
	`on_allocation_exhausted` text,
	`run_on_dependency_failure` integer NOT NULL,
	`gate_acceptance_criterion_ids` text,
	`output_artifact_ids` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`,`created_in_revision_number`) REFERENCES `execution_plan_revisions`(`run_id`,`number`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "plan_nodes_kind" CHECK("plan_nodes"."kind" IN ('pattern', 'join')),
	CONSTRAINT "plan_nodes_status" CHECK("plan_nodes"."status" IN ('pending', 'ready', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'skipped')),
	CONSTRAINT "plan_nodes_pattern" CHECK("plan_nodes"."pattern" IS NULL OR "plan_nodes"."pattern" IN ('single', 'chain', 'route', 'parallel', 'coordinator_worker', 'evaluator_optimizer')),
	CONSTRAINT "plan_nodes_fan_in_policy" CHECK("plan_nodes"."fan_in_policy" IS NULL OR "plan_nodes"."fan_in_policy" IN ('require_all', 'require_any')),
	CONSTRAINT "plan_nodes_on_allocation_exhausted" CHECK("plan_nodes"."on_allocation_exhausted" IS NULL OR "plan_nodes"."on_allocation_exhausted" IN ('fail', 'wait', 'extend')),
	CONSTRAINT "plan_nodes_wait_reason" CHECK("plan_nodes"."wait_reason" IS NULL OR "plan_nodes"."wait_reason" IN ('decision', 'budget', 'provider_capacity', 'integration_conflict', 'operator')),
	CONSTRAINT "plan_nodes_waiting_has_reason" CHECK(("plan_nodes"."status" = 'waiting') = ("plan_nodes"."wait_reason" IS NOT NULL)),
	CONSTRAINT "plan_nodes_pattern_shape" CHECK("plan_nodes"."kind" <> 'pattern' OR ("plan_nodes"."pattern" IS NOT NULL AND "plan_nodes"."fan_in_policy" IS NULL AND "plan_nodes"."shape" IS NOT NULL AND json_extract("plan_nodes"."shape", '$.pattern') = "plan_nodes"."pattern" AND "plan_nodes"."input" IS NOT NULL AND "plan_nodes"."on_allocation_exhausted" IS NOT NULL AND "plan_nodes"."gate_acceptance_criterion_ids" IS NOT NULL)),
	CONSTRAINT "plan_nodes_join_shape" CHECK("plan_nodes"."kind" <> 'join' OR ("plan_nodes"."pattern" IS NULL AND "plan_nodes"."fan_in_policy" IS NOT NULL AND "plan_nodes"."shape" IS NULL AND "plan_nodes"."input" IS NULL AND "plan_nodes"."on_allocation_exhausted" IS NULL AND "plan_nodes"."gate_acceptance_criterion_ids" IS NULL AND "plan_nodes"."alloc_cost_usd" = 0 AND "plan_nodes"."alloc_tokens" = 0 AND "plan_nodes"."alloc_attempts" = 0)),
	CONSTRAINT "plan_nodes_root_shape" CHECK("plan_nodes"."source_path" <> 'root' OR ("plan_nodes"."kind" = 'pattern' AND "plan_nodes"."pattern" = 'single' AND json_extract("plan_nodes"."shape", '$.role') = 'orchestrator')),
	CONSTRAINT "plan_nodes_orchestrator_only_root" CHECK("plan_nodes"."kind" <> 'pattern' OR "plan_nodes"."pattern" <> 'single' OR "plan_nodes"."source_path" = 'root' OR json_extract("plan_nodes"."shape", '$.role') = 'worker'),
	CONSTRAINT "plan_nodes_join_never_runs" CHECK("plan_nodes"."kind" <> 'join' OR "plan_nodes"."status" NOT IN ('running', 'waiting')),
	CONSTRAINT "plan_nodes_alloc_non_negative" CHECK("plan_nodes"."alloc_cost_usd" >= 0 AND "plan_nodes"."alloc_tokens" >= 0 AND "plan_nodes"."alloc_attempts" >= 0),
	CONSTRAINT "plan_nodes_terminal_has_ended_at" CHECK(("plan_nodes"."status" IN ('succeeded', 'failed', 'cancelled', 'skipped')) = ("plan_nodes"."ended_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `plan_nodes_run_status` ON `plan_nodes` (`run_id`,`status`);--> statement-breakpoint
CREATE INDEX `plan_nodes_run_source_path` ON `plan_nodes` (`run_id`,`source_path`);--> statement-breakpoint
CREATE TABLE `plan_revision_nodes` (
	`run_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`plan_node_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`run_id`, `revision_number`, `plan_node_id`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_node_id`) REFERENCES `plan_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`,`revision_number`) REFERENCES `execution_plan_revisions`(`run_id`,`number`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "plan_revision_nodes_position" CHECK("plan_revision_nodes"."position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_revision_nodes_position` ON `plan_revision_nodes` (`run_id`,`revision_number`,`position`);--> statement-breakpoint
CREATE INDEX `plan_revision_nodes_node` ON `plan_revision_nodes` (`plan_node_id`);--> statement-breakpoint
CREATE TABLE `provider_continuations` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`storage_key` text NOT NULL,
	`digest` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "provider_continuations_digest_shape" CHECK(length("provider_continuations"."digest") = 64)
);
--> statement-breakpoint
CREATE INDEX `provider_continuations_expires` ON `provider_continuations` (`expires_at`);--> statement-breakpoint
CREATE TABLE `publications` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`decision_id` text NOT NULL,
	`changeset_id` text NOT NULL,
	`requested_strategy` text NOT NULL,
	`strategy` text,
	`target_before_snapshot_id` text,
	`candidate_snapshot_id` text,
	`target_after_snapshot_id` text,
	`status` text NOT NULL,
	`failure` text,
	`report_artifact_id` text,
	`staging_cleanup` text NOT NULL,
	`created_at` text NOT NULL,
	`prepared_at` text,
	`verified_at` text,
	`applying_at` text,
	`ended_at` text,
	`staging_released_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`changeset_id`) REFERENCES `changesets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_before_snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_after_snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`report_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "publications_status" CHECK("publications"."status" IN ('requested', 'prepared', 'verified', 'applying', 'succeeded', 'failed')),
	CONSTRAINT "publications_staging_cleanup" CHECK("publications"."staging_cleanup" IN ('pending', 'released')),
	CONSTRAINT "publications_prepared_shape" CHECK(("publications"."prepared_at" IS NOT NULL) = ("publications"."strategy" IS NOT NULL) AND ("publications"."prepared_at" IS NOT NULL) = ("publications"."target_before_snapshot_id" IS NOT NULL) AND ("publications"."prepared_at" IS NOT NULL) = ("publications"."candidate_snapshot_id" IS NOT NULL)),
	CONSTRAINT "publications_prepared_status" CHECK(("publications"."status" NOT IN ('prepared', 'verified', 'applying', 'succeeded') OR "publications"."prepared_at" IS NOT NULL) AND ("publications"."status" <> 'requested' OR "publications"."prepared_at" IS NULL)),
	CONSTRAINT "publications_verified_status" CHECK(("publications"."status" NOT IN ('verified', 'applying', 'succeeded') OR "publications"."verified_at" IS NOT NULL) AND ("publications"."status" NOT IN ('requested', 'prepared') OR "publications"."verified_at" IS NULL)),
	CONSTRAINT "publications_applying_status" CHECK(("publications"."status" NOT IN ('applying', 'succeeded') OR "publications"."applying_at" IS NOT NULL) AND ("publications"."status" NOT IN ('requested', 'prepared', 'verified') OR "publications"."applying_at" IS NULL)),
	CONSTRAINT "publications_milestones_monotone" CHECK(("publications"."verified_at" IS NULL OR "publications"."prepared_at" IS NOT NULL) AND ("publications"."applying_at" IS NULL OR "publications"."verified_at" IS NOT NULL)),
	CONSTRAINT "publications_failure_shape" CHECK(("publications"."status" = 'failed') = ("publications"."failure" IS NOT NULL)),
	CONSTRAINT "publications_terminal_shape" CHECK(("publications"."status" IN ('succeeded', 'failed')) = ("publications"."ended_at" IS NOT NULL) AND ("publications"."status" IN ('succeeded', 'failed')) = ("publications"."report_artifact_id" IS NOT NULL)),
	CONSTRAINT "publications_after_snapshot" CHECK(("publications"."status" = 'succeeded') = ("publications"."target_after_snapshot_id" IS NOT NULL) AND ("publications"."status" <> 'succeeded' OR "publications"."target_after_snapshot_id" = "publications"."candidate_snapshot_id")),
	CONSTRAINT "publications_failure_stage" CHECK("publications"."failure" IS NULL OR ((json_extract("publications"."failure", '$.kind') <> 'verification_failed' OR "publications"."prepared_at" IS NOT NULL) AND (json_extract("publications"."failure", '$.kind') <> 'target_changed' OR "publications"."applying_at" IS NOT NULL) AND (json_extract("publications"."failure", '$.kind') NOT IN ('strategy_unsupported', 'fast_forward_unavailable', 'candidate_conflict', 'candidate_invalid') OR "publications"."verified_at" IS NULL))),
	CONSTRAINT "publications_cleanup_shape" CHECK((("publications"."staging_cleanup" = 'released') = ("publications"."staging_released_at" IS NOT NULL)) AND ("publications"."staging_cleanup" <> 'released' OR "publications"."status" IN ('succeeded', 'failed')))
);
--> statement-breakpoint
CREATE INDEX `publications_run` ON `publications` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `publications_status` ON `publications` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `publications_decision` ON `publications` (`decision_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `publications_active_run` ON `publications` (`run_id`) WHERE status NOT IN ('succeeded', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX `publications_succeeded_run` ON `publications` (`run_id`) WHERE status = 'succeeded';--> statement-breakpoint
CREATE TABLE `requirement_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`number` integer NOT NULL,
	`approved_by_decision_id` text,
	`tree` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by_decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "requirement_revisions_number" CHECK("requirement_revisions"."number" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `requirement_revisions_conversation_number` ON `requirement_revisions` (`conversation_id`,`number`);--> statement-breakpoint
CREATE TABLE `requirement_status_changes` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`requirement_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`actor` text NOT NULL,
	`evidence` text NOT NULL,
	`gate_id` text,
	`decision_id` text,
	`rationale` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`requirement_id`) REFERENCES `requirements`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`gate_id`) REFERENCES `gates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "requirement_status_changes_from" CHECK("requirement_status_changes"."from_status" IN ('open', 'satisfied', 'violated', 'infeasible', 'waived', 'retired')),
	CONSTRAINT "requirement_status_changes_to" CHECK("requirement_status_changes"."to_status" IN ('open', 'satisfied', 'violated', 'infeasible', 'waived', 'retired')),
	CONSTRAINT "requirement_status_changes_actor" CHECK("requirement_status_changes"."actor" IN ('runtime', 'operator', 'orchestrator')),
	CONSTRAINT "requirement_status_changes_waiver" CHECK("requirement_status_changes"."to_status" <> 'waived' OR ("requirement_status_changes"."decision_id" IS NOT NULL AND "requirement_status_changes"."actor" = 'operator')),
	CONSTRAINT "requirement_status_changes_satisfied" CHECK("requirement_status_changes"."to_status" <> 'satisfied' OR ("requirement_status_changes"."gate_id" IS NOT NULL AND "requirement_status_changes"."actor" = 'runtime'))
);
--> statement-breakpoint
CREATE INDEX `requirement_status_changes_requirement` ON `requirement_status_changes` (`requirement_id`,`seq`);--> statement-breakpoint
CREATE TABLE `requirements` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`status` text NOT NULL,
	`created_in_revision_id` text NOT NULL,
	`retired_in_revision_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_in_revision_id`) REFERENCES `requirement_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`retired_in_revision_id`) REFERENCES `requirement_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "requirements_status" CHECK("requirements"."status" IN ('open', 'satisfied', 'violated', 'infeasible', 'waived', 'retired')),
	CONSTRAINT "requirements_retired_revision" CHECK(("requirements"."status" = 'retired') = ("requirements"."retired_in_revision_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `requirements_conversation` ON `requirements` (`conversation_id`,`status`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`wait_reason` text,
	`target` text NOT NULL,
	`max_cost_usd` real NOT NULL,
	`max_tokens` integer NOT NULL,
	`max_attempts` integer NOT NULL,
	`max_wall_clock_ms` integer,
	`max_concurrency` integer,
	`final_reserve_cost_usd` real NOT NULL,
	`final_reserve_tokens` integer NOT NULL,
	`final_reserve_attempts` integer NOT NULL,
	`verification_policy` text NOT NULL,
	`base_snapshot_id` text,
	`integration_snapshot_id` text,
	`final_snapshot_id` text,
	`final_changeset_id` text,
	`integration_workspace_path` text,
	`failure` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`base_snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`integration_snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`final_snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`final_changeset_id`) REFERENCES `changesets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "runs_kind" CHECK("runs"."kind" IN ('code', 'other')),
	CONSTRAINT "runs_status" CHECK("runs"."status" IN ('created', 'running', 'waiting', 'verifying', 'awaiting_signoff', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "runs_wait_reason" CHECK("runs"."wait_reason" IS NULL OR "runs"."wait_reason" IN ('decision', 'budget', 'provider_capacity', 'integration_conflict', 'operator')),
	CONSTRAINT "runs_waiting_has_reason" CHECK(("runs"."status" = 'waiting') = ("runs"."wait_reason" IS NOT NULL)),
	CONSTRAINT "runs_failed_has_failure" CHECK(("runs"."status" = 'failed') = ("runs"."failure" IS NOT NULL)),
	CONSTRAINT "runs_terminal_has_ended_at" CHECK(("runs"."status" IN ('completed', 'failed', 'cancelled')) = ("runs"."ended_at" IS NOT NULL)),
	CONSTRAINT "runs_completed_has_final" CHECK(("runs"."status" = 'completed' AND "runs"."final_snapshot_id" IS NOT NULL AND "runs"."final_changeset_id" IS NOT NULL) OR ("runs"."status" <> 'completed' AND "runs"."final_snapshot_id" IS NULL AND "runs"."final_changeset_id" IS NULL)),
	CONSTRAINT "runs_budget_non_negative" CHECK("runs"."max_cost_usd" >= 0 AND "runs"."max_tokens" >= 0 AND "runs"."max_attempts" >= 0),
	CONSTRAINT "runs_final_reserve_non_negative" CHECK("runs"."final_reserve_cost_usd" >= 0 AND "runs"."final_reserve_tokens" >= 0 AND "runs"."final_reserve_attempts" >= 0),
	CONSTRAINT "runs_final_reserve_within_budget" CHECK("runs"."final_reserve_cost_usd" <= "runs"."max_cost_usd" AND "runs"."final_reserve_tokens" <= "runs"."max_tokens" AND "runs"."final_reserve_attempts" <= "runs"."max_attempts"),
	CONSTRAINT "runs_verification_policy_shape" CHECK(json_type("runs"."verification_policy", '$.maxNodeGateCycles') = 'integer' AND json_extract("runs"."verification_policy", '$.maxNodeGateCycles') >= 1 AND json_extract("runs"."verification_policy", '$.maxNodeGateCycles') <= 10 AND json_type("runs"."verification_policy", '$.maxRunCompletionCycles') = 'integer' AND json_extract("runs"."verification_policy", '$.maxRunCompletionCycles') >= 1 AND json_extract("runs"."verification_policy", '$.maxRunCompletionCycles') <= 10 AND json_type("runs"."verification_policy", '$.runCompletionAcceptanceCriterionIds') = 'array' AND (json_type("runs"."verification_policy", '$.evaluatorAgentDefinitionRevisionId') = 'null' OR json_extract("runs"."verification_policy", '$.evaluatorAgentDefinitionRevisionId') GLOB 'agdr_*'))
);
--> statement-breakpoint
CREATE INDEX `runs_conversation` ON `runs` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_status` ON `runs` (`status`);--> statement-breakpoint
CREATE TABLE `runtime_tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`plan_node_id` text NOT NULL,
	`invocation_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`tool` text NOT NULL,
	`call_digest` text NOT NULL,
	`result` text NOT NULL,
	`committed_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_node_id`) REFERENCES `plan_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "runtime_tool_calls_tool" CHECK("runtime_tool_calls"."tool" IN ('propose_tasks', 'update_task', 'request_completion', 'request_decision')),
	CONSTRAINT "runtime_tool_calls_digest_shape" CHECK(length("runtime_tool_calls"."call_digest") = 64),
	CONSTRAINT "runtime_tool_calls_result_tool" CHECK(json_extract("runtime_tool_calls"."result", '$.tool') = "runtime_tool_calls"."tool")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_tool_calls_invocation_call` ON `runtime_tool_calls` (`invocation_id`,`tool`,`call_digest`);--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_tool_calls_one_proposal` ON `runtime_tool_calls` (`invocation_id`) WHERE tool = 'propose_tasks';--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_tool_calls_one_decision_request` ON `runtime_tool_calls` (`invocation_id`) WHERE tool = 'request_decision';--> statement-breakpoint
CREATE INDEX `runtime_tool_calls_plan_node` ON `runtime_tool_calls` (`plan_node_id`,`committed_at`);--> statement-breakpoint
CREATE INDEX `runtime_tool_calls_attempt` ON `runtime_tool_calls` (`attempt_id`);--> statement-breakpoint
CREATE TABLE `schema_info` (
	`id` integer PRIMARY KEY NOT NULL,
	`application` text NOT NULL,
	`schema` text NOT NULL,
	`version` integer NOT NULL,
	CONSTRAINT "schema_info_single_row" CHECK("schema_info"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `signoff_resolutions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`gate_id` text NOT NULL,
	`decision_id` text NOT NULL,
	`outcome` text NOT NULL,
	`operator_message_id` text,
	`final_changeset_id` text,
	`follow_up_invocation_id` text,
	`resolved_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`gate_id`) REFERENCES `gates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`operator_message_id`) REFERENCES `conversation_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`final_changeset_id`) REFERENCES `changesets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`follow_up_invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "signoff_resolutions_outcome" CHECK("signoff_resolutions"."outcome" IN ('accept', 'request_changes')),
	CONSTRAINT "signoff_resolutions_accept_shape" CHECK(("signoff_resolutions"."outcome" = 'accept') = ("signoff_resolutions"."final_changeset_id" IS NOT NULL)),
	CONSTRAINT "signoff_resolutions_request_changes_shape" CHECK(("signoff_resolutions"."outcome" = 'request_changes') = ("signoff_resolutions"."operator_message_id" IS NOT NULL)),
	CONSTRAINT "signoff_resolutions_follow_up_shape" CHECK("signoff_resolutions"."outcome" = 'request_changes' OR "signoff_resolutions"."follow_up_invocation_id" IS NULL)
);
--> statement-breakpoint
CREATE INDEX `signoff_resolutions_run` ON `signoff_resolutions` (`run_id`,`resolved_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `signoff_resolutions_gate` ON `signoff_resolutions` (`gate_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `signoff_resolutions_decision` ON `signoff_resolutions` (`decision_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `signoff_resolutions_operator_message` ON `signoff_resolutions` (`operator_message_id`) WHERE operator_message_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `signoff_resolutions_final_changeset` ON `signoff_resolutions` (`final_changeset_id`) WHERE final_changeset_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `signoff_resolutions_follow_up` ON `signoff_resolutions` (`follow_up_invocation_id`) WHERE follow_up_invocation_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text,
	`kind` text NOT NULL,
	`commit_id` text,
	`tree_id` text,
	`content_digest` text,
	`reason` text NOT NULL,
	`taken_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "snapshots_kind" CHECK("snapshots"."kind" IN ('git', 'directory')),
	CONSTRAINT "snapshots_reason" CHECK("snapshots"."reason" IN ('run_start', 'before_invocation', 'after_invocation', 'integration', 'run_completion', 'publish_before', 'publish_candidate', 'agent_definition_read')),
	CONSTRAINT "snapshots_identity" CHECK(("snapshots"."kind" = 'git' AND "snapshots"."commit_id" IS NOT NULL AND "snapshots"."tree_id" IS NOT NULL AND "snapshots"."content_digest" IS NULL) OR ("snapshots"."kind" = 'directory' AND "snapshots"."content_digest" IS NOT NULL AND "snapshots"."commit_id" IS NULL AND "snapshots"."tree_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `snapshots_run` ON `snapshots` (`run_id`,`taken_at`);--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`run_id` text NOT NULL,
	`task_id` text NOT NULL,
	`depends_on_task_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `depends_on_task_id`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`depends_on_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_dependencies_no_self" CHECK("task_dependencies"."task_id" <> "task_dependencies"."depends_on_task_id")
);
--> statement-breakpoint
CREATE INDEX `task_dependencies_depends_on` ON `task_dependencies` (`depends_on_task_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`plan_node_id` text,
	`invocation_id` text,
	`origin` text NOT NULL,
	`gate_id` text,
	`subject` text NOT NULL,
	`requirement_ids` text NOT NULL,
	`requirement_revision_id` text,
	`input_artifact_ids` text NOT NULL,
	`required_outputs` text NOT NULL,
	`output_artifact_ids` text NOT NULL,
	`evidence` text NOT NULL,
	`status` text NOT NULL,
	`block_reason` text,
	`failure_reason` text,
	`replaces_task_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_node_id`) REFERENCES `plan_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`gate_id`) REFERENCES `gates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requirement_revision_id`) REFERENCES `requirement_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`replaces_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_status" CHECK("tasks"."status" IN ('pending', 'ready', 'running', 'blocked', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "tasks_origin" CHECK("tasks"."origin" IN ('orchestrator', 'coordinator', 'runtime')),
	CONSTRAINT "tasks_failure_reason" CHECK("tasks"."failure_reason" IS NULL OR "tasks"."failure_reason" IN ('attempts_exhausted', 'permanent_failure', 'allocation_exhausted')),
	CONSTRAINT "tasks_blocked_has_reason" CHECK(("tasks"."status" = 'blocked') = ("tasks"."block_reason" IS NOT NULL)),
	CONSTRAINT "tasks_failed_has_reason" CHECK(("tasks"."status" = 'failed') = ("tasks"."failure_reason" IS NOT NULL)),
	CONSTRAINT "tasks_terminal_has_ended_at" CHECK(("tasks"."status" IN ('completed', 'failed', 'cancelled')) = ("tasks"."ended_at" IS NOT NULL)),
	CONSTRAINT "tasks_coordinator_scope" CHECK("tasks"."origin" <> 'coordinator' OR ("tasks"."plan_node_id" IS NOT NULL AND "tasks"."requirement_revision_id" IS NOT NULL)),
	CONSTRAINT "tasks_no_self_replace" CHECK("tasks"."replaces_task_id" IS NULL OR "tasks"."replaces_task_id" <> "tasks"."id"),
	CONSTRAINT "tasks_gate_remediation_shape" CHECK("tasks"."gate_id" IS NULL OR ("tasks"."origin" = 'runtime' AND "tasks"."plan_node_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `tasks_run_status` ON `tasks` (`run_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_plan_node` ON `tasks` (`plan_node_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_replaced_once` ON `tasks` (`replaces_task_id`) WHERE replaces_task_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_gate_remediation` ON `tasks` (`gate_id`) WHERE gate_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `usage` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`plan_node_id` text NOT NULL,
	`invocation_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`input_tokens_uncached` integer NOT NULL,
	`cache_creation_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`wall_clock_ms` integer NOT NULL,
	`provider_ms` integer,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_node_id`) REFERENCES `plan_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "usage_effort" CHECK("usage"."effort" IS NULL OR "usage"."effort" IN ('low', 'medium', 'high', 'max')),
	CONSTRAINT "usage_non_negative" CHECK("usage"."input_tokens_uncached" >= 0 AND "usage"."cache_creation_tokens" >= 0 AND "usage"."cache_read_tokens" >= 0 AND "usage"."output_tokens" >= 0 AND "usage"."cost_usd" >= 0 AND "usage"."wall_clock_ms" >= 0)
);
--> statement-breakpoint
CREATE INDEX `usage_run` ON `usage` (`run_id`);--> statement-breakpoint
CREATE INDEX `usage_plan_node` ON `usage` (`plan_node_id`);--> statement-breakpoint
CREATE INDEX `usage_invocation` ON `usage` (`invocation_id`);--> statement-breakpoint
CREATE INDEX `usage_attempt` ON `usage` (`attempt_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`root_path` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "workspaces_kind" CHECK("workspaces"."kind" IN ('git', 'directory'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_root_path_unique` ON `workspaces` (`root_path`);--> statement-breakpoint
INSERT INTO `schema_info` (`id`, `application`, `schema`, `version`) VALUES (1, 'agentique-console', 'orchestration-core', 1);--> statement-breakpoint
CREATE TRIGGER `schema_info_no_delete` BEFORE DELETE ON `schema_info` BEGIN SELECT RAISE(ABORT, 'schema_info is never deleted'); END;--> statement-breakpoint
CREATE TRIGGER `events_no_update` BEFORE UPDATE ON `events` BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `events_no_delete` BEFORE DELETE ON `events` BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `runs_definition_immutable` BEFORE UPDATE OF `conversation_id`, `workspace_id`, `kind`, `target`, `final_reserve_cost_usd`, `final_reserve_tokens`, `final_reserve_attempts`, `verification_policy`, `created_at` ON `runs` BEGIN SELECT RAISE(ABORT, 'run definition columns are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `runs_no_delete` BEFORE DELETE ON `runs` BEGIN SELECT RAISE(ABORT, 'runs are never deleted'); END;--> statement-breakpoint
CREATE TRIGGER `runs_final_references_valid` BEFORE UPDATE OF `final_changeset_id` ON `runs` WHEN NEW.`final_changeset_id` IS NOT NULL BEGIN SELECT RAISE(ABORT, 'a completed run names its own final changeset, which runs from its base snapshot to its final snapshot') WHERE NOT EXISTS (SELECT 1 FROM `changesets` c WHERE c.`id` = NEW.`final_changeset_id` AND c.`run_id` = NEW.`id` AND c.`kind` = 'final' AND c.`after_snapshot_id` = NEW.`final_snapshot_id` AND c.`before_snapshot_id` = NEW.`base_snapshot_id`); END;--> statement-breakpoint
CREATE TRIGGER `runs_final_references_immutable` BEFORE UPDATE OF `final_snapshot_id`, `final_changeset_id` ON `runs` WHEN OLD.`final_changeset_id` IS NOT NULL BEGIN SELECT RAISE(ABORT, 'a completed run''s final references never change'); END;--> statement-breakpoint
CREATE TRIGGER `execution_plan_revisions_no_update` BEFORE UPDATE ON `execution_plan_revisions` BEGIN SELECT RAISE(ABORT, 'execution_plan_revisions are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `execution_plan_revisions_no_delete` BEFORE DELETE ON `execution_plan_revisions` BEGIN SELECT RAISE(ABORT, 'execution_plan_revisions are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `plan_edges_no_update` BEFORE UPDATE ON `plan_edges` BEGIN SELECT RAISE(ABORT, 'plan_edges are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `plan_edges_no_delete` BEFORE DELETE ON `plan_edges` BEGIN SELECT RAISE(ABORT, 'plan_edges are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `plan_revision_nodes_no_update` BEFORE UPDATE ON `plan_revision_nodes` BEGIN SELECT RAISE(ABORT, 'plan_revision_nodes are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `plan_revision_nodes_no_delete` BEFORE DELETE ON `plan_revision_nodes` BEGIN SELECT RAISE(ABORT, 'plan_revision_nodes are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `plan_node_requirements_no_update` BEFORE UPDATE ON `plan_node_requirements` BEGIN SELECT RAISE(ABORT, 'plan_node_requirements are never updated'); END;--> statement-breakpoint
CREATE TRIGGER `plan_node_requirements_no_delete` BEFORE DELETE ON `plan_node_requirements` BEGIN SELECT RAISE(ABORT, 'plan_node_requirements are never deleted'); END;--> statement-breakpoint
CREATE TRIGGER `plan_nodes_definition_immutable` BEFORE UPDATE OF `run_id`, `created_in_revision_number`, `kind`, `pattern`, `title`, `source_path`, `fan_in_policy`, `input`, `shape`, `alloc_cost_usd`, `alloc_tokens`, `alloc_attempts`, `max_concurrency`, `max_wall_clock_ms`, `on_allocation_exhausted`, `run_on_dependency_failure`, `gate_acceptance_criterion_ids`, `created_at` ON `plan_nodes` BEGIN SELECT RAISE(ABORT, 'plan_nodes definition columns are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `plan_nodes_no_delete` BEFORE DELETE ON `plan_nodes` BEGIN SELECT RAISE(ABORT, 'plan_nodes are never deleted'); END;--> statement-breakpoint
CREATE TRIGGER `requirement_revisions_no_update` BEFORE UPDATE ON `requirement_revisions` BEGIN SELECT RAISE(ABORT, 'requirement_revisions are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `requirement_revisions_no_delete` BEFORE DELETE ON `requirement_revisions` BEGIN SELECT RAISE(ABORT, 'requirement_revisions are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `requirement_status_changes_no_update` BEFORE UPDATE ON `requirement_status_changes` BEGIN SELECT RAISE(ABORT, 'requirement_status_changes are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `requirement_status_changes_no_delete` BEFORE DELETE ON `requirement_status_changes` BEGIN SELECT RAISE(ABORT, 'requirement_status_changes are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `acceptance_criteria_no_update` BEFORE UPDATE ON `acceptance_criteria` BEGIN SELECT RAISE(ABORT, 'acceptance_criteria are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `acceptance_criteria_no_delete` BEFORE DELETE ON `acceptance_criteria` BEGIN SELECT RAISE(ABORT, 'acceptance_criteria are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `decisions_request_immutable` BEFORE UPDATE OF `conversation_id`, `run_id`, `kind`, `resolution_policy`, `requested_by`, `question`, `options`, `recommended_option_id`, `rationale`, `affects`, `deadline_at`, `activation_condition`, `subject`, `supersedes_decision_id`, `created_at` ON `decisions` BEGIN SELECT RAISE(ABORT, 'decision request fields are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `decisions_resolution_immutable` BEFORE UPDATE OF `resolved_by`, `chosen_option_id`, `resolution_rationale`, `resolution_artifact_ids`, `resolved_at` ON `decisions` WHEN OLD.`resolved_by` IS NOT NULL BEGIN SELECT RAISE(ABORT, 'a decision resolution is recorded once'); END;--> statement-breakpoint
CREATE TRIGGER `decisions_no_delete` BEFORE DELETE ON `decisions` BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `tasks_definition_immutable` BEFORE UPDATE OF `run_id`, `plan_node_id`, `origin`, `gate_id`, `subject`, `requirement_ids`, `requirement_revision_id`, `input_artifact_ids`, `required_outputs`, `replaces_task_id`, `created_at` ON `tasks` BEGIN SELECT RAISE(ABORT, 'task definition columns are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `tasks_no_delete` BEFORE DELETE ON `tasks` BEGIN SELECT RAISE(ABORT, 'tasks are never deleted'); END;--> statement-breakpoint
CREATE TRIGGER `tasks_gate_remediation_valid` BEFORE INSERT ON `tasks` WHEN NEW.`gate_id` IS NOT NULL BEGIN SELECT RAISE(ABORT, 'a gate remediation task addresses a failed gate of its own run on the gated plan node, or a failed run_completion gate from the root plan node') WHERE NOT EXISTS (SELECT 1 FROM `gates` g JOIN `plan_nodes` n ON n.`id` = NEW.`plan_node_id` WHERE g.`id` = NEW.`gate_id` AND g.`run_id` = NEW.`run_id` AND g.`status` = 'failed' AND ((g.`plan_node_id` IS NOT NULL AND g.`plan_node_id` = NEW.`plan_node_id`) OR (g.`plan_node_id` IS NULL AND g.`kind` = 'run_completion' AND n.`source_path` = 'root' AND n.`run_id` = NEW.`run_id`))); END;--> statement-breakpoint
CREATE TRIGGER `task_dependencies_no_update` BEFORE UPDATE ON `task_dependencies` BEGIN SELECT RAISE(ABORT, 'task_dependencies are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `artifacts_no_update` BEFORE UPDATE ON `artifacts` BEGIN SELECT RAISE(ABORT, 'artifacts are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `artifacts_no_delete` BEFORE DELETE ON `artifacts` BEGIN SELECT RAISE(ABORT, 'artifacts are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `handoffs_routing_immutable` BEFORE UPDATE OF `run_id`, `source`, `target`, `task_ids`, `artifact_ids`, `summary`, `created_at` ON `handoffs` BEGIN SELECT RAISE(ABORT, 'handoff routing fields are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `handoffs_no_delete` BEFORE DELETE ON `handoffs` BEGIN SELECT RAISE(ABORT, 'handoffs are never deleted'); END;--> statement-breakpoint
CREATE TRIGGER `agent_definition_revisions_no_update` BEFORE UPDATE ON `agent_definition_revisions` BEGIN SELECT RAISE(ABORT, 'agent_definition_revisions are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `agent_definition_revisions_no_delete` BEFORE DELETE ON `agent_definition_revisions` BEGIN SELECT RAISE(ABORT, 'agent_definition_revisions are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `invocations_definition_immutable` BEFORE UPDATE OF `run_id`, `plan_node_id`, `role`, `purpose`, `agent_definition_revision_id`, `continued_from_invocation_id`, `pattern_position`, `pattern_position_key`, `gate_id`, `task_ids`, `alloc_cost_usd`, `alloc_tokens`, `alloc_attempts`, `allocation_source`, `final_reserve_use`, `created_at` ON `invocations` BEGIN SELECT RAISE(ABORT, 'invocation definition columns are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `invocations_no_delete` BEFORE DELETE ON `invocations` BEGIN SELECT RAISE(ABORT, 'invocations are never deleted'); END;--> statement-breakpoint
CREATE TRIGGER `invocations_gate_evaluator_valid` BEFORE INSERT ON `invocations` WHEN NEW.`gate_id` IS NOT NULL AND NEW.`role` = 'evaluator' BEGIN SELECT RAISE(ABORT, 'a gate evaluator invocation judges an open gate of its own run and plan node and executes the run''s verification-policy evaluator revision') WHERE NOT EXISTS (SELECT 1 FROM `gates` g JOIN `runs` r ON r.`id` = NEW.`run_id` JOIN `plan_nodes` n ON n.`id` = NEW.`plan_node_id` WHERE g.`id` = NEW.`gate_id` AND g.`run_id` = NEW.`run_id` AND g.`status` = 'open' AND ((g.`plan_node_id` IS NOT NULL AND g.`plan_node_id` = NEW.`plan_node_id`) OR (g.`plan_node_id` IS NULL AND n.`source_path` = 'root')) AND json_extract(r.`verification_policy`, '$.evaluatorAgentDefinitionRevisionId') = NEW.`agent_definition_revision_id`); END;--> statement-breakpoint
CREATE TRIGGER `invocations_final_synthesis_valid` BEFORE INSERT ON `invocations` WHEN NEW.`purpose` = 'final_synthesis' AND NEW.`gate_id` IS NOT NULL BEGIN SELECT RAISE(ABORT, 'a final_synthesis turn reports on an open run_completion gate of its own run, from the root plan node, funded from the final reserve') WHERE NOT EXISTS (SELECT 1 FROM `gates` g JOIN `plan_nodes` n ON n.`id` = NEW.`plan_node_id` WHERE g.`id` = NEW.`gate_id` AND g.`run_id` = NEW.`run_id` AND g.`kind` = 'run_completion' AND g.`status` = 'open' AND n.`source_path` = 'root' AND NEW.`final_reserve_use` = 'final_synthesis'); END;--> statement-breakpoint
CREATE TRIGGER `attempts_definition_immutable` BEFORE UPDATE OF `invocation_id`, `run_id`, `plan_node_id`, `number`, `kind`, `start_mode`, `resumed_from_attempt_id`, `created_at` ON `attempts` BEGIN SELECT RAISE(ABORT, 'attempt definition columns are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `attempts_no_delete` BEFORE DELETE ON `attempts` BEGIN SELECT RAISE(ABORT, 'attempts are never deleted'); END;--> statement-breakpoint
CREATE TRIGGER `attempts_terminal_immutable` BEFORE UPDATE OF `status`, `failure_class`, `failure_detail`, `retry_decision`, `retry_not_before`, `result`, `transcript_artifact_id`, `ended_at` ON `attempts` WHEN OLD.`status` IN ('succeeded', 'failed', 'timed_out', 'interrupted', 'cancelled') BEGIN SELECT RAISE(ABORT, 'a terminal attempt never changes again'); END;--> statement-breakpoint
CREATE TRIGGER `approved_tool_call_uses_no_update` BEFORE UPDATE ON `approved_tool_call_uses` BEGIN SELECT RAISE(ABORT, 'approved_tool_call_uses are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `approved_tool_call_uses_no_delete` BEFORE DELETE ON `approved_tool_call_uses` BEGIN SELECT RAISE(ABORT, 'approved_tool_call_uses are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `approved_tool_call_uses_claim_valid` BEFORE INSERT ON `approved_tool_call_uses` BEGIN SELECT RAISE(ABORT, 'an approved_tool_call_use claims a resolved approve_once side_effect_approval of its own Run and Plan Node whose subject names the call and the running invocation''s predecessor, carried by that invocation''s manifest, from its running attempt') WHERE NOT EXISTS (SELECT 1 FROM `decisions` d JOIN `invocations` i ON i.`id` = NEW.`invocation_id` JOIN `attempts` a ON a.`id` = NEW.`attempt_id` WHERE d.`id` = NEW.`decision_id` AND d.`kind` = 'side_effect_approval' AND d.`status` = 'resolved' AND d.`chosen_option_id` = 'approve_once' AND d.`run_id` = NEW.`run_id` AND json_extract(d.`subject`, '$.tool') = NEW.`tool` AND json_extract(d.`subject`, '$.callDigest') = NEW.`call_digest` AND json_extract(d.`subject`, '$.runId') = NEW.`run_id` AND json_extract(d.`subject`, '$.planNodeId') = NEW.`plan_node_id` AND json_extract(d.`subject`, '$.invocationId') = i.`continued_from_invocation_id` AND i.`run_id` = NEW.`run_id` AND i.`plan_node_id` = NEW.`plan_node_id` AND i.`status` = 'running' AND a.`invocation_id` = NEW.`invocation_id` AND a.`status` = 'running' AND EXISTS (SELECT 1 FROM `context_manifests` cm, json_each(cm.`content`, '$.approvedCalls') ac WHERE cm.`invocation_id` = NEW.`invocation_id` AND json_extract(ac.`value`, '$.decisionId') = NEW.`decision_id` AND json_extract(ac.`value`, '$.tool') = NEW.`tool` AND json_extract(ac.`value`, '$.callDigest') = NEW.`call_digest`)); END;--> statement-breakpoint
CREATE TRIGGER `runtime_tool_calls_no_update` BEFORE UPDATE ON `runtime_tool_calls` BEGIN SELECT RAISE(ABORT, 'runtime_tool_calls are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `runtime_tool_calls_no_delete` BEFORE DELETE ON `runtime_tool_calls` BEGIN SELECT RAISE(ABORT, 'runtime_tool_calls are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `context_manifests_no_update` BEFORE UPDATE ON `context_manifests` BEGIN SELECT RAISE(ABORT, 'context_manifests are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `context_manifests_no_delete` BEFORE DELETE ON `context_manifests` BEGIN SELECT RAISE(ABORT, 'context_manifests are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `evaluations_no_update` BEFORE UPDATE ON `evaluations` BEGIN SELECT RAISE(ABORT, 'evaluations are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `evaluations_no_delete` BEFORE DELETE ON `evaluations` BEGIN SELECT RAISE(ABORT, 'evaluations are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `evaluations_gate_valid` BEFORE INSERT ON `evaluations` WHEN NEW.`gate_id` IS NOT NULL BEGIN SELECT RAISE(ABORT, 'a gate evaluation judges one criterion of an open gate of its own run on the gate''s pinned snapshot and plan node (none for a run gate)') WHERE NOT EXISTS (SELECT 1 FROM `gates` g WHERE g.`id` = NEW.`gate_id` AND g.`run_id` = NEW.`run_id` AND g.`status` = 'open' AND g.`plan_node_id` IS NEW.`plan_node_id` AND g.`snapshot_id` = NEW.`snapshot_id` AND json_extract(NEW.`subject`, '$.kind') = 'acceptance_criterion' AND EXISTS (SELECT 1 FROM json_each(g.`acceptance_criterion_ids`) c WHERE c.`value` = json_extract(NEW.`subject`, '$.acceptanceCriterionId'))); END;--> statement-breakpoint
CREATE TRIGGER `gates_definition_immutable` BEFORE UPDATE OF `run_id`, `plan_node_id`, `kind`, `ordinal`, `acceptance_criterion_ids`, `snapshot_id`, `candidate_artifact_ids`, `completion_request_id`, `requirement_revision_id`, `requirement_ids`, `completion_gate_id`, `opened_at` ON `gates` BEGIN SELECT RAISE(ABORT, 'gate definition columns are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `gates_closed_immutable` BEFORE UPDATE ON `gates` WHEN OLD.`status` <> 'open' BEGIN SELECT RAISE(ABORT, 'a closed gate never changes again'); END;--> statement-breakpoint
CREATE TRIGGER `gates_no_delete` BEFORE DELETE ON `gates` BEGIN SELECT RAISE(ABORT, 'gates are append-only history'); END;--> statement-breakpoint
CREATE TRIGGER `gates_report_immutable` BEFORE UPDATE OF `report_artifact_id` ON `gates` WHEN OLD.`report_artifact_id` IS NOT NULL BEGIN SELECT RAISE(ABORT, 'a gate records its final report once'); END;--> statement-breakpoint
CREATE TRIGGER `completion_requests_identity_immutable` BEFORE UPDATE OF `id`, `run_id`, `invocation_id`, `runtime_tool_call_id`, `created_at` ON `completion_requests` BEGIN SELECT RAISE(ABORT, 'completion request identity columns are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `completion_requests_gate_immutable` BEFORE UPDATE OF `gate_id` ON `completion_requests` WHEN OLD.`gate_id` IS NOT NULL AND NEW.`gate_id` IS NOT OLD.`gate_id` BEGIN SELECT RAISE(ABORT, 'a completion request names its gate once'); END;--> statement-breakpoint
CREATE TRIGGER `completion_requests_terminal_immutable` BEFORE UPDATE ON `completion_requests` WHEN OLD.`status` IN ('passed', 'failed', 'cancelled') BEGIN SELECT RAISE(ABORT, 'a terminal completion request never changes again'); END;--> statement-breakpoint
CREATE TRIGGER `completion_requests_no_delete` BEFORE DELETE ON `completion_requests` BEGIN SELECT RAISE(ABORT, 'completion requests are append-only history'); END;--> statement-breakpoint
CREATE TRIGGER `snapshots_no_update` BEFORE UPDATE ON `snapshots` BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `snapshots_no_delete` BEFORE DELETE ON `snapshots` BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `changesets_definition_immutable` BEFORE UPDATE OF `run_id`, `kind`, `invocation_id`, `before_snapshot_id`, `after_snapshot_id`, `diff_artifact_id`, `created_at` ON `changesets` BEGIN SELECT RAISE(ABORT, 'changeset definition columns are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `changesets_final_immutable` BEFORE UPDATE ON `changesets` WHEN OLD.`kind` = 'final' BEGIN SELECT RAISE(ABORT, 'the final changeset is recorded once and never changes'); END;--> statement-breakpoint
CREATE TRIGGER `changesets_no_delete` BEFORE DELETE ON `changesets` BEGIN SELECT RAISE(ABORT, 'changesets are never deleted'); END;--> statement-breakpoint
CREATE TRIGGER `changesets_final_valid` BEFORE INSERT ON `changesets` WHEN NEW.`kind` = 'final' BEGIN SELECT RAISE(ABORT, 'the final changeset is recorded for a run awaiting signoff, from its base snapshot to the open operator_signoff gate''s verified snapshot, with a text/x-diff artifact of the run') WHERE NOT EXISTS (SELECT 1 FROM `runs` r JOIN `gates` g ON g.`run_id` = r.`id` JOIN `artifacts` a ON a.`id` = NEW.`diff_artifact_id` WHERE r.`id` = NEW.`run_id` AND r.`status` = 'awaiting_signoff' AND r.`base_snapshot_id` = NEW.`before_snapshot_id` AND g.`kind` = 'operator_signoff' AND g.`status` = 'open' AND g.`snapshot_id` = NEW.`after_snapshot_id` AND a.`run_id` = NEW.`run_id` AND a.`media_type` = 'text/x-diff'); END;--> statement-breakpoint
CREATE TRIGGER `signoff_resolutions_valid` BEFORE INSERT ON `signoff_resolutions` BEGIN SELECT RAISE(ABORT, 'a signoff resolution resolves an open operator_signoff gate of its run through the gate''s open signoff decision; an accept names the run''s final changeset ending at the gate''s verified snapshot, a request_changes names an operator message of the run''s conversation') WHERE NOT EXISTS (SELECT 1 FROM `gates` g JOIN `decisions` d ON d.`id` = NEW.`decision_id` WHERE g.`id` = NEW.`gate_id` AND g.`run_id` = NEW.`run_id` AND g.`kind` = 'operator_signoff' AND g.`status` = 'open' AND d.`run_id` = NEW.`run_id` AND d.`kind` = 'signoff' AND d.`status` = 'open' AND json_extract(d.`subject`, '$.gateId') = NEW.`gate_id` AND ((NEW.`outcome` = 'accept' AND EXISTS (SELECT 1 FROM `changesets` c WHERE c.`id` = NEW.`final_changeset_id` AND c.`run_id` = NEW.`run_id` AND c.`kind` = 'final' AND c.`after_snapshot_id` = g.`snapshot_id`)) OR (NEW.`outcome` = 'request_changes' AND EXISTS (SELECT 1 FROM `conversation_messages` m WHERE m.`id` = NEW.`operator_message_id` AND m.`conversation_id` = d.`conversation_id` AND m.`author` = 'operator')))); END;--> statement-breakpoint
CREATE TRIGGER `signoff_resolutions_identity_immutable` BEFORE UPDATE OF `id`, `run_id`, `gate_id`, `decision_id`, `outcome`, `operator_message_id`, `final_changeset_id`, `resolved_at` ON `signoff_resolutions` BEGIN SELECT RAISE(ABORT, 'signoff resolution identity and outcome are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `signoff_resolutions_follow_up_once` BEFORE UPDATE OF `follow_up_invocation_id` ON `signoff_resolutions` WHEN OLD.`follow_up_invocation_id` IS NOT NULL BEGIN SELECT RAISE(ABORT, 'a signoff resolution links its follow-up invocation once'); END;--> statement-breakpoint
CREATE TRIGGER `signoff_resolutions_follow_up_valid` BEFORE UPDATE OF `follow_up_invocation_id` ON `signoff_resolutions` WHEN NEW.`follow_up_invocation_id` IS NOT NULL BEGIN SELECT RAISE(ABORT, 'a request_changes signoff resolution links a root decision_resolution orchestrator invocation of its run') WHERE NEW.`outcome` <> 'request_changes' OR NOT EXISTS (SELECT 1 FROM `invocations` i JOIN `plan_nodes` n ON n.`id` = i.`plan_node_id` WHERE i.`id` = NEW.`follow_up_invocation_id` AND i.`run_id` = NEW.`run_id` AND i.`role` = 'orchestrator' AND i.`purpose` = 'decision_resolution' AND n.`source_path` = 'root'); END;--> statement-breakpoint
CREATE TRIGGER `signoff_resolutions_no_delete` BEFORE DELETE ON `signoff_resolutions` BEGIN SELECT RAISE(ABORT, 'signoff resolutions are append-only history'); END;--> statement-breakpoint
CREATE TRIGGER `publications_identity_immutable` BEFORE UPDATE OF `id`, `run_id`, `decision_id`, `changeset_id`, `requested_strategy`, `created_at` ON `publications` BEGIN SELECT RAISE(ABORT, 'publication identity columns are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `publications_prepared_immutable` BEFORE UPDATE OF `strategy`, `target_before_snapshot_id`, `candidate_snapshot_id`, `prepared_at` ON `publications` WHEN OLD.`prepared_at` IS NOT NULL BEGIN SELECT RAISE(ABORT, 'a publication records its prepared facts once'); END;--> statement-breakpoint
CREATE TRIGGER `publications_terminal_immutable` BEFORE UPDATE OF `status`, `strategy`, `target_before_snapshot_id`, `candidate_snapshot_id`, `target_after_snapshot_id`, `failure`, `report_artifact_id`, `prepared_at`, `verified_at`, `applying_at`, `ended_at` ON `publications` WHEN OLD.`status` IN ('succeeded', 'failed') BEGIN SELECT RAISE(ABORT, 'a terminal publication never changes again'); END;--> statement-breakpoint
CREATE TRIGGER `publications_cleanup_once` BEFORE UPDATE OF `staging_cleanup`, `staging_released_at` ON `publications` WHEN OLD.`staging_cleanup` = 'released' BEGIN SELECT RAISE(ABORT, 'publication staging resources are released once'); END;--> statement-breakpoint
CREATE TRIGGER `publications_no_delete` BEFORE DELETE ON `publications` BEGIN SELECT RAISE(ABORT, 'publications are append-only history'); END;--> statement-breakpoint
CREATE TRIGGER `publications_boundary_valid` BEFORE INSERT ON `publications` BEGIN SELECT RAISE(ABORT, 'a publication belongs to a completed run, is authorized by the run''s operator-resolved publish decision, applies the run''s final changeset, and a published run is never published again') WHERE NOT EXISTS (SELECT 1 FROM `runs` r JOIN `decisions` d ON d.`id` = NEW.`decision_id` WHERE r.`id` = NEW.`run_id` AND r.`status` = 'completed' AND r.`final_changeset_id` = NEW.`changeset_id` AND d.`run_id` = NEW.`run_id` AND d.`kind` = 'publish' AND d.`status` = 'resolved' AND d.`resolved_by` = 'operator' AND d.`chosen_option_id` = 'publish') OR EXISTS (SELECT 1 FROM `publications` p WHERE p.`run_id` = NEW.`run_id` AND p.`status` = 'succeeded'); END;--> statement-breakpoint
CREATE TRIGGER `budget_reservations_definition_immutable` BEFORE UPDATE OF `run_id`, `parent_type`, `parent_id`, `child_type`, `child_id`, `reserved_cost_usd`, `reserved_tokens`, `reserved_attempts`, `capacity_source`, `final_reserve_use`, `transferred_from_reservation_id`, `created_at` ON `budget_reservations` BEGIN SELECT RAISE(ABORT, 'budget_reservation allocation columns are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `budget_reservations_released_once` BEFORE UPDATE ON `budget_reservations` WHEN OLD.`status` = 'released' BEGIN SELECT RAISE(ABORT, 'a released budget_reservation never changes again'); END;--> statement-breakpoint
CREATE TRIGGER `budget_reservations_no_delete` BEFORE DELETE ON `budget_reservations` BEGIN SELECT RAISE(ABORT, 'budget_reservations are historical records'); END;--> statement-breakpoint
CREATE TRIGGER `capacity_leases_released_once` BEFORE UPDATE ON `capacity_leases` WHEN OLD.`status` = 'released' BEGIN SELECT RAISE(ABORT, 'a released capacity_lease never changes again'); END;--> statement-breakpoint
CREATE TRIGGER `usage_no_update` BEFORE UPDATE ON `usage` BEGIN SELECT RAISE(ABORT, 'usage is append-only'); END;--> statement-breakpoint
CREATE TRIGGER `usage_no_delete` BEFORE DELETE ON `usage` BEGIN SELECT RAISE(ABORT, 'usage is append-only'); END;--> statement-breakpoint
CREATE TRIGGER `conversation_messages_no_update` BEFORE UPDATE ON `conversation_messages` BEGIN SELECT RAISE(ABORT, 'conversation_messages are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `conversation_messages_no_delete` BEFORE DELETE ON `conversation_messages` BEGIN SELECT RAISE(ABORT, 'conversation_messages are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `budget_increases_no_update` BEFORE UPDATE ON `budget_increases` BEGIN SELECT RAISE(ABORT, 'budget_increases are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `budget_increases_no_delete` BEFORE DELETE ON `budget_increases` BEGIN SELECT RAISE(ABORT, 'budget_increases are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `budget_increases_valid` BEFORE INSERT ON `budget_increases` BEGIN SELECT RAISE(ABORT, 'a budget increase is authorized by the run''s operator-approved budget_increase decision whose subject names exactly this partition and these quantities, for a nonterminal run whose status admits the partition') WHERE NOT EXISTS (SELECT 1 FROM `decisions` d JOIN `runs` r ON r.`id` = NEW.`run_id` WHERE d.`id` = NEW.`decision_id` AND d.`run_id` = NEW.`run_id` AND d.`kind` = 'budget_increase' AND d.`status` = 'resolved' AND d.`resolved_by` = 'operator' AND d.`chosen_option_id` = 'approve' AND json_extract(d.`subject`, '$.runId') = NEW.`run_id` AND json_extract(d.`subject`, '$.partition') = NEW.`partition` AND json_extract(d.`subject`, '$.added.costUsd') = NEW.`added_cost_usd` AND json_extract(d.`subject`, '$.added.tokens') = NEW.`added_tokens` AND json_extract(d.`subject`, '$.added.attempts') = NEW.`added_attempts` AND r.`status` NOT IN ('completed', 'failed', 'cancelled') AND (NEW.`partition` = 'ordinary' OR r.`status` IN ('created', 'running', 'waiting'))); END;--> statement-breakpoint
CREATE TRIGGER `allocation_extensions_no_update` BEFORE UPDATE ON `allocation_extensions` BEGIN SELECT RAISE(ABORT, 'allocation_extensions are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `allocation_extensions_no_delete` BEFORE DELETE ON `allocation_extensions` BEGIN SELECT RAISE(ABORT, 'allocation_extensions are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `allocation_extensions_valid` BEFORE INSERT ON `allocation_extensions` BEGIN SELECT RAISE(ABORT, 'an allocation extension raises the active ordinary run-to-plan-node reservation of a nonterminal pattern plan node of its own run') WHERE NOT EXISTS (SELECT 1 FROM `budget_reservations` b JOIN `plan_nodes` n ON n.`id` = NEW.`plan_node_id` WHERE b.`id` = NEW.`reservation_id` AND b.`run_id` = NEW.`run_id` AND b.`parent_type` = 'run' AND b.`parent_id` = NEW.`run_id` AND b.`child_type` = 'plan_node' AND b.`child_id` = NEW.`plan_node_id` AND b.`capacity_source` = 'ordinary' AND b.`status` = 'active' AND n.`run_id` = NEW.`run_id` AND n.`kind` = 'pattern' AND n.`status` NOT IN ('succeeded', 'failed', 'cancelled', 'skipped')); END;--> statement-breakpoint
CREATE TRIGGER `decisions_superseded_immutable` BEFORE UPDATE ON `decisions` WHEN OLD.`status` = 'superseded' BEGIN SELECT RAISE(ABORT, 'a superseded decision never changes again'); END;--> statement-breakpoint
CREATE TRIGGER `decisions_requester_valid` BEFORE INSERT ON `decisions` WHEN json_extract(NEW.`requested_by`, '$.kind') = 'invocation' AND NEW.`kind` IN ('operator_choice', 'requirement_waiver') BEGIN SELECT RAISE(ABORT, 'an agent-requested decision is requested by a running invocation of its own run') WHERE NOT EXISTS (SELECT 1 FROM `invocations` i WHERE i.`id` = json_extract(NEW.`requested_by`, '$.invocationId') AND i.`run_id` = NEW.`run_id` AND i.`status` = 'running'); END;--> statement-breakpoint
CREATE TRIGGER `decisions_waiver_subject_valid` BEFORE INSERT ON `decisions` WHEN NEW.`kind` = 'requirement_waiver' BEGIN SELECT RAISE(ABORT, 'a requirement_waiver pins a requirement and a requirement revision of its own conversation') WHERE NOT EXISTS (SELECT 1 FROM `requirements` r JOIN `requirement_revisions` rr ON rr.`id` = json_extract(NEW.`subject`, '$.requirementRevisionId') WHERE r.`id` = json_extract(NEW.`subject`, '$.requirementId') AND r.`conversation_id` = NEW.`conversation_id` AND rr.`conversation_id` = NEW.`conversation_id`); END;--> statement-breakpoint
CREATE TRIGGER `decisions_resolution_option_valid` BEFORE UPDATE OF `chosen_option_id` ON `decisions` WHEN NEW.`chosen_option_id` IS NOT NULL BEGIN SELECT RAISE(ABORT, 'a decision resolves to one of its own options') WHERE NOT EXISTS (SELECT 1 FROM json_each(NEW.`options`) WHERE json_extract(value, '$.id') = NEW.`chosen_option_id`); END;--> statement-breakpoint
CREATE TRIGGER `invocations_blocked_decision_valid` BEFORE UPDATE OF `status` ON `invocations` WHEN NEW.`status` = 'blocked' BEGIN SELECT RAISE(ABORT, 'a blocked invocation names the open decision that ended it: the side_effect_approval of its intercepted call, or the operator_choice or requirement_waiver it requested') WHERE NOT EXISTS (SELECT 1 FROM `decisions` d WHERE d.`id` = NEW.`blocked_by_decision_id` AND d.`run_id` = NEW.`run_id` AND d.`status` = 'open' AND ((d.`kind` = 'side_effect_approval' AND json_extract(d.`subject`, '$.invocationId') = NEW.`id`) OR (d.`kind` IN ('operator_choice', 'requirement_waiver') AND json_extract(d.`requested_by`, '$.invocationId') = NEW.`id`))); END;--> statement-breakpoint
CREATE TRIGGER `requirement_status_changes_waiver_valid` BEFORE INSERT ON `requirement_status_changes` WHEN NEW.`to_status` = 'waived' BEGIN SELECT RAISE(ABORT, 'a waiver status change references the operator-resolved requirement_waiver decision that chose waive for this requirement') WHERE NOT EXISTS (SELECT 1 FROM `decisions` d WHERE d.`id` = NEW.`decision_id` AND d.`kind` = 'requirement_waiver' AND d.`status` = 'resolved' AND d.`resolved_by` = 'operator' AND d.`chosen_option_id` = 'waive' AND d.`conversation_id` = NEW.`conversation_id` AND json_extract(d.`subject`, '$.requirementId') = NEW.`requirement_id`); END;--> statement-breakpoint
CREATE TRIGGER `runtime_tool_calls_decision_request_valid` BEFORE INSERT ON `runtime_tool_calls` WHEN NEW.`tool` = 'request_decision' BEGIN SELECT RAISE(ABORT, 'an accepted request_decision names an open requestable decision of its own run requested by its invocation') WHERE NOT EXISTS (SELECT 1 FROM `decisions` d WHERE d.`id` = json_extract(NEW.`result`, '$.decisionId') AND d.`run_id` = NEW.`run_id` AND d.`status` = 'open' AND d.`kind` IN ('operator_choice', 'requirement_waiver') AND json_extract(d.`requested_by`, '$.invocationId') = NEW.`invocation_id`); END;
