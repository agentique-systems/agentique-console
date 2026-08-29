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
	CONSTRAINT "attempts_failure_class" CHECK("attempts"."failure_class" IS NULL OR "attempts"."failure_class" IN ('provider_transient', 'provider_permanent', 'result_invalid', 'allocation_exhausted', 'interrupted', 'tool_failure')),
	CONSTRAINT "attempts_number" CHECK("attempts"."number" >= 1),
	CONSTRAINT "attempts_initial_is_first" CHECK(("attempts"."number" = 1) = ("attempts"."kind" = 'initial')),
	CONSTRAINT "attempts_resumed_from" CHECK(("attempts"."start_mode" = 'resumed') = ("attempts"."resumed_from_attempt_id" IS NOT NULL)),
	CONSTRAINT "attempts_no_self_resume" CHECK("attempts"."resumed_from_attempt_id" IS NULL OR "attempts"."resumed_from_attempt_id" <> "attempts"."id"),
	CONSTRAINT "attempts_terminal_has_ended_at" CHECK(("attempts"."status" IN ('succeeded', 'failed', 'timed_out', 'interrupted', 'cancelled')) = ("attempts"."ended_at" IS NOT NULL)),
	CONSTRAINT "attempts_succeeded_shape" CHECK("attempts"."status" <> 'succeeded' OR ("attempts"."result" IS NOT NULL AND "attempts"."failure_class" IS NULL)),
	CONSTRAINT "attempts_failure_classified" CHECK("attempts"."status" NOT IN ('failed', 'timed_out', 'interrupted') OR "attempts"."failure_class" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_invocation_number` ON `attempts` (`invocation_id`,`number`);--> statement-breakpoint
CREATE INDEX `attempts_run_status` ON `attempts` (`run_id`,`status`);--> statement-breakpoint
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
	CONSTRAINT "changesets_status" CHECK("changesets"."integration_status" IN ('pending', 'integrated', 'conflict')),
	CONSTRAINT "changesets_integrated_shape" CHECK(("changesets"."integration_status" = 'integrated') = ("changesets"."integrated_snapshot_id" IS NOT NULL AND "changesets"."integrated_at" IS NOT NULL)),
	CONSTRAINT "changesets_conflict_shape" CHECK(("changesets"."integration_status" = 'conflict') = ("changesets"."conflict_task_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `changesets_run` ON `changesets` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `context_manifests` (
	`id` text PRIMARY KEY NOT NULL,
	`invocation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`content` text NOT NULL,
	`digest` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "context_manifests_digest_shape" CHECK(length("context_manifests"."digest") = 64)
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
	`resolved_by` text,
	`chosen_option_id` text,
	`resolution_rationale` text,
	`resolution_artifact_ids` text,
	`resolved_at` text,
	`supersedes_decision_id` text,
	`superseded_by_decision_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supersedes_decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`superseded_by_decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "decisions_kind" CHECK("decisions"."kind" IN ('operator_choice', 'orchestrator_choice', 'requirement_waiver', 'side_effect_approval', 'signoff', 'publish')),
	CONSTRAINT "decisions_policy" CHECK("decisions"."resolution_policy" IN ('operator_required', 'use_default_after_deadline')),
	CONSTRAINT "decisions_status" CHECK("decisions"."status" IN ('open', 'resolved', 'superseded')),
	CONSTRAINT "decisions_resolver" CHECK("decisions"."resolved_by" IS NULL OR "decisions"."resolved_by" IN ('operator', 'orchestrator', 'policy:use_default_after_deadline')),
	CONSTRAINT "decisions_waiver_operator_required" CHECK("decisions"."kind" <> 'requirement_waiver' OR "decisions"."resolution_policy" = 'operator_required'),
	CONSTRAINT "decisions_operator_only_kinds" CHECK("decisions"."kind" NOT IN ('requirement_waiver', 'side_effect_approval', 'signoff', 'publish') OR "decisions"."resolved_by" IS NULL OR "decisions"."resolved_by" = 'operator'),
	CONSTRAINT "decisions_default_policy_shape" CHECK("decisions"."resolution_policy" <> 'use_default_after_deadline' OR ("decisions"."kind" = 'operator_choice' AND "decisions"."recommended_option_id" IS NOT NULL AND "decisions"."rationale" IS NOT NULL AND ("decisions"."deadline_at" IS NOT NULL OR "decisions"."activation_condition" IS NOT NULL))),
	CONSTRAINT "decisions_policy_resolver" CHECK("decisions"."resolved_by" IS NULL OR "decisions"."resolved_by" <> 'policy:use_default_after_deadline' OR ("decisions"."resolution_policy" = 'use_default_after_deadline' AND "decisions"."chosen_option_id" = "decisions"."recommended_option_id")),
	CONSTRAINT "decisions_resolution_shape" CHECK(("decisions"."status" = 'open' AND "decisions"."resolved_by" IS NULL AND "decisions"."chosen_option_id" IS NULL AND "decisions"."resolved_at" IS NULL) OR ("decisions"."status" = 'resolved' AND "decisions"."resolved_by" IS NOT NULL AND "decisions"."chosen_option_id" IS NOT NULL AND "decisions"."resolved_at" IS NOT NULL) OR "decisions"."status" = 'superseded'),
	CONSTRAINT "decisions_superseded_by" CHECK(("decisions"."status" = 'superseded') = ("decisions"."superseded_by_decision_id" IS NOT NULL)),
	CONSTRAINT "decisions_no_self_supersede" CHECK("decisions"."supersedes_decision_id" IS NULL OR "decisions"."supersedes_decision_id" <> "decisions"."id")
);
--> statement-breakpoint
CREATE INDEX `decisions_conversation_status` ON `decisions` (`conversation_id`,`status`);--> statement-breakpoint
CREATE INDEX `decisions_run` ON `decisions` (`run_id`);--> statement-breakpoint
CREATE TABLE `evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`plan_node_id` text,
	`gate_id` text,
	`subject` text NOT NULL,
	`verdict` text NOT NULL,
	`evidence` text NOT NULL,
	`produced_by` text NOT NULL,
	`artifact_ids` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_node_id`) REFERENCES `plan_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`gate_id`) REFERENCES `gates`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "evaluations_verdict" CHECK("evaluations"."verdict" IN ('pass', 'fail', 'inconclusive'))
);
--> statement-breakpoint
CREATE INDEX `evaluations_run` ON `evaluations` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `evaluations_gate` ON `evaluations` (`gate_id`);--> statement-breakpoint
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
	`status` text NOT NULL,
	`acceptance_criterion_ids` text NOT NULL,
	`snapshot_id` text,
	`opened_at` text NOT NULL,
	`closed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_node_id`) REFERENCES `plan_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "gates_kind" CHECK("gates"."kind" IN ('node_exit', 'run_completion', 'operator_signoff')),
	CONSTRAINT "gates_status" CHECK("gates"."status" IN ('open', 'passed', 'failed')),
	CONSTRAINT "gates_node_exit_has_node" CHECK(("gates"."kind" = 'node_exit') = ("gates"."plan_node_id" IS NOT NULL)),
	CONSTRAINT "gates_closed_at" CHECK(("gates"."status" = 'open') = ("gates"."closed_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `gates_run` ON `gates` (`run_id`,`kind`,`status`);--> statement-breakpoint
CREATE TABLE `handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`source` text NOT NULL,
	`target` text NOT NULL,
	`task_ids` text NOT NULL,
	`artifact_ids` text NOT NULL,
	`summary` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`delivered_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "handoffs_status" CHECK("handoffs"."status" IN ('pending', 'delivered', 'cancelled')),
	CONSTRAINT "handoffs_summary_length" CHECK(length("handoffs"."summary") <= 500),
	CONSTRAINT "handoffs_delivered_at" CHECK(("handoffs"."status" = 'delivered') = ("handoffs"."delivered_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `handoffs_run` ON `handoffs` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`plan_node_id` text NOT NULL,
	`role` text NOT NULL,
	`purpose` text NOT NULL,
	`agent_definition_revision_id` text NOT NULL,
	`continued_from_invocation_id` text,
	`task_ids` text NOT NULL,
	`alloc_cost_usd` real NOT NULL,
	`alloc_tokens` integer NOT NULL,
	`alloc_attempts` integer NOT NULL,
	`allocation_source` text NOT NULL,
	`final_reserve_use` text,
	`status` text NOT NULL,
	`wait_reason` text,
	`failure_reason` text,
	`result` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_node_id`) REFERENCES `plan_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_definition_revision_id`) REFERENCES `agent_definition_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`continued_from_invocation_id`) REFERENCES `invocations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invocations_role" CHECK("invocations"."role" IN ('orchestrator', 'worker', 'coordinator', 'evaluator')),
	CONSTRAINT "invocations_allocation_source" CHECK("invocations"."allocation_source" IN ('plan_node', 'run_final_reserve')),
	CONSTRAINT "invocations_final_reserve_use" CHECK("invocations"."final_reserve_use" IS NULL OR "invocations"."final_reserve_use" IN ('final_synthesis', 'run_completion')),
	CONSTRAINT "invocations_final_reserve_shape" CHECK(("invocations"."allocation_source" = 'run_final_reserve') = ("invocations"."final_reserve_use" IS NOT NULL)),
	CONSTRAINT "invocations_final_reserve_binding" CHECK("invocations"."final_reserve_use" IS NULL OR ("invocations"."final_reserve_use" = 'final_synthesis' AND "invocations"."role" = 'orchestrator' AND "invocations"."purpose" = 'final_synthesis') OR ("invocations"."final_reserve_use" = 'run_completion' AND "invocations"."role" = 'evaluator' AND "invocations"."purpose" = 'evaluate')),
	CONSTRAINT "invocations_final_reserve_no_tasks" CHECK("invocations"."allocation_source" = 'plan_node' OR "invocations"."task_ids" = '[]'),
	CONSTRAINT "invocations_purpose" CHECK("invocations"."purpose" IN ('operator_input', 'plan_revision', 'node_result', 'decision_resolution', 'gate_result', 'publication_result', 'final_synthesis', 'step', 'task', 'select', 'evaluate', 'decompose', 'replan', 'synthesize')),
	CONSTRAINT "invocations_role_purpose" CHECK((role = 'orchestrator' AND purpose IN ('operator_input', 'plan_revision', 'node_result', 'decision_resolution', 'gate_result', 'publication_result', 'final_synthesis')) OR (role = 'worker' AND purpose IN ('step', 'task')) OR (role = 'evaluator' AND purpose IN ('select', 'evaluate')) OR (role = 'coordinator' AND purpose IN ('decompose', 'replan', 'synthesize'))),
	CONSTRAINT "invocations_status" CHECK("invocations"."status" IN ('pending', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "invocations_wait_reason" CHECK("invocations"."wait_reason" IS NULL OR "invocations"."wait_reason" IN ('decision', 'budget', 'provider_capacity', 'operator')),
	CONSTRAINT "invocations_failure_reason" CHECK("invocations"."failure_reason" IS NULL OR "invocations"."failure_reason" IN ('attempts_exhausted', 'provider_permanent', 'allocation_exhausted', 'result_invalid', 'cancelled')),
	CONSTRAINT "invocations_waiting_has_reason" CHECK(("invocations"."status" = 'waiting') = ("invocations"."wait_reason" IS NOT NULL)),
	CONSTRAINT "invocations_failed_has_reason" CHECK(("invocations"."status" = 'failed') = ("invocations"."failure_reason" IS NOT NULL)),
	CONSTRAINT "invocations_terminal_has_ended_at" CHECK(("invocations"."status" IN ('succeeded', 'failed', 'cancelled')) = ("invocations"."ended_at" IS NOT NULL)),
	CONSTRAINT "invocations_alloc_attempts" CHECK("invocations"."alloc_attempts" >= 1 AND "invocations"."alloc_cost_usd" >= 0 AND "invocations"."alloc_tokens" >= 0),
	CONSTRAINT "invocations_no_self_continue" CHECK("invocations"."continued_from_invocation_id" IS NULL OR "invocations"."continued_from_invocation_id" <> "invocations"."id")
);
--> statement-breakpoint
CREATE INDEX `invocations_plan_node_status` ON `invocations` (`plan_node_id`,`status`);--> statement-breakpoint
CREATE INDEX `invocations_run_status` ON `invocations` (`run_id`,`status`);--> statement-breakpoint
CREATE INDEX `invocations_plan_node_source` ON `invocations` (`plan_node_id`,`allocation_source`);--> statement-breakpoint
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
	CONSTRAINT "plan_nodes_wait_reason" CHECK("plan_nodes"."wait_reason" IS NULL OR "plan_nodes"."wait_reason" IN ('decision', 'budget', 'provider_capacity', 'operator')),
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
	`target_before_snapshot_id` text NOT NULL,
	`target_after_snapshot_id` text,
	`strategy` text NOT NULL,
	`outcome` text NOT NULL,
	`failure_reason` text,
	`artifact_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`changeset_id`) REFERENCES `changesets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_before_snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_after_snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "publications_outcome" CHECK("publications"."outcome" IN ('succeeded', 'failed')),
	CONSTRAINT "publications_failure_reason" CHECK(("publications"."outcome" = 'failed') = ("publications"."failure_reason" IS NOT NULL)),
	CONSTRAINT "publications_after_snapshot" CHECK(("publications"."outcome" = 'succeeded') = ("publications"."target_after_snapshot_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `publications_run` ON `publications` (`run_id`,`created_at`);--> statement-breakpoint
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
	`base_snapshot_id` text,
	`integration_snapshot_id` text,
	`final_snapshot_id` text,
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
	CONSTRAINT "runs_kind" CHECK("runs"."kind" IN ('code', 'other')),
	CONSTRAINT "runs_status" CHECK("runs"."status" IN ('created', 'running', 'waiting', 'verifying', 'awaiting_signoff', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "runs_wait_reason" CHECK("runs"."wait_reason" IS NULL OR "runs"."wait_reason" IN ('decision', 'budget', 'provider_capacity', 'operator')),
	CONSTRAINT "runs_waiting_has_reason" CHECK(("runs"."status" = 'waiting') = ("runs"."wait_reason" IS NOT NULL)),
	CONSTRAINT "runs_failed_has_failure" CHECK(("runs"."status" = 'failed') = ("runs"."failure" IS NOT NULL)),
	CONSTRAINT "runs_terminal_has_ended_at" CHECK(("runs"."status" IN ('completed', 'failed', 'cancelled')) = ("runs"."ended_at" IS NOT NULL)),
	CONSTRAINT "runs_budget_non_negative" CHECK("runs"."max_cost_usd" >= 0 AND "runs"."max_tokens" >= 0 AND "runs"."max_attempts" >= 0),
	CONSTRAINT "runs_final_reserve_non_negative" CHECK("runs"."final_reserve_cost_usd" >= 0 AND "runs"."final_reserve_tokens" >= 0 AND "runs"."final_reserve_attempts" >= 0),
	CONSTRAINT "runs_final_reserve_within_budget" CHECK("runs"."final_reserve_cost_usd" <= "runs"."max_cost_usd" AND "runs"."final_reserve_tokens" <= "runs"."max_tokens" AND "runs"."final_reserve_attempts" <= "runs"."max_attempts")
);
--> statement-breakpoint
CREATE INDEX `runs_conversation` ON `runs` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_status` ON `runs` (`status`);--> statement-breakpoint
CREATE TABLE `schema_info` (
	`id` integer PRIMARY KEY NOT NULL,
	`application` text NOT NULL,
	`schema` text NOT NULL,
	`version` integer NOT NULL,
	CONSTRAINT "schema_info_single_row" CHECK("schema_info"."id" = 1)
);
--> statement-breakpoint
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
	CONSTRAINT "snapshots_reason" CHECK("snapshots"."reason" IN ('run_start', 'before_invocation', 'after_invocation', 'integration', 'run_completion', 'publish_before', 'publish_after', 'agent_definition_read')),
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
	FOREIGN KEY (`requirement_revision_id`) REFERENCES `requirement_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`replaces_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_status" CHECK("tasks"."status" IN ('pending', 'ready', 'running', 'blocked', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "tasks_origin" CHECK("tasks"."origin" IN ('orchestrator', 'coordinator', 'runtime')),
	CONSTRAINT "tasks_failure_reason" CHECK("tasks"."failure_reason" IS NULL OR "tasks"."failure_reason" IN ('attempts_exhausted', 'permanent_failure', 'allocation_exhausted')),
	CONSTRAINT "tasks_blocked_has_reason" CHECK(("tasks"."status" = 'blocked') = ("tasks"."block_reason" IS NOT NULL)),
	CONSTRAINT "tasks_failed_has_reason" CHECK(("tasks"."status" = 'failed') = ("tasks"."failure_reason" IS NOT NULL)),
	CONSTRAINT "tasks_terminal_has_ended_at" CHECK(("tasks"."status" IN ('completed', 'failed', 'cancelled')) = ("tasks"."ended_at" IS NOT NULL)),
	CONSTRAINT "tasks_coordinator_scope" CHECK("tasks"."origin" <> 'coordinator' OR ("tasks"."plan_node_id" IS NOT NULL AND "tasks"."requirement_revision_id" IS NOT NULL)),
	CONSTRAINT "tasks_no_self_replace" CHECK("tasks"."replaces_task_id" IS NULL OR "tasks"."replaces_task_id" <> "tasks"."id")
);
--> statement-breakpoint
CREATE INDEX `tasks_run_status` ON `tasks` (`run_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_plan_node` ON `tasks` (`plan_node_id`,`status`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `workspaces_root_path_unique` ON `workspaces` (`root_path`);
--> statement-breakpoint
INSERT INTO `schema_info` (`id`, `application`, `schema`, `version`) VALUES (1, 'agentique-console', 'orchestration-core', 1);--> statement-breakpoint
CREATE TRIGGER `schema_info_no_delete` BEFORE DELETE ON `schema_info` BEGIN SELECT RAISE(ABORT, 'schema_info is never deleted'); END;--> statement-breakpoint
CREATE TRIGGER `events_no_update` BEFORE UPDATE ON `events` BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `events_no_delete` BEFORE DELETE ON `events` BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `runs_definition_immutable` BEFORE UPDATE OF `conversation_id`, `workspace_id`, `kind`, `target`, `final_reserve_cost_usd`, `final_reserve_tokens`, `final_reserve_attempts`, `created_at` ON `runs` BEGIN SELECT RAISE(ABORT, 'run definition columns are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `runs_no_delete` BEFORE DELETE ON `runs` BEGIN SELECT RAISE(ABORT, 'runs are never deleted'); END;--> statement-breakpoint
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
CREATE TRIGGER `decisions_request_immutable` BEFORE UPDATE OF `conversation_id`, `run_id`, `kind`, `resolution_policy`, `requested_by`, `question`, `options`, `recommended_option_id`, `rationale`, `affects`, `deadline_at`, `activation_condition`, `supersedes_decision_id`, `created_at` ON `decisions` BEGIN SELECT RAISE(ABORT, 'decision request fields are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `decisions_resolution_immutable` BEFORE UPDATE OF `resolved_by`, `chosen_option_id`, `resolution_rationale`, `resolution_artifact_ids`, `resolved_at` ON `decisions` WHEN OLD.`resolved_by` IS NOT NULL BEGIN SELECT RAISE(ABORT, 'a decision resolution is recorded once'); END;--> statement-breakpoint
CREATE TRIGGER `decisions_no_delete` BEFORE DELETE ON `decisions` BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `tasks_definition_immutable` BEFORE UPDATE OF `run_id`, `plan_node_id`, `origin`, `subject`, `requirement_ids`, `requirement_revision_id`, `input_artifact_ids`, `required_outputs`, `replaces_task_id`, `created_at` ON `tasks` BEGIN SELECT RAISE(ABORT, 'task definition columns are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `tasks_no_delete` BEFORE DELETE ON `tasks` BEGIN SELECT RAISE(ABORT, 'tasks are never deleted'); END;--> statement-breakpoint
CREATE TRIGGER `task_dependencies_no_update` BEFORE UPDATE ON `task_dependencies` BEGIN SELECT RAISE(ABORT, 'task_dependencies are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `artifacts_no_update` BEFORE UPDATE ON `artifacts` BEGIN SELECT RAISE(ABORT, 'artifacts are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `artifacts_no_delete` BEFORE DELETE ON `artifacts` BEGIN SELECT RAISE(ABORT, 'artifacts are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `handoffs_routing_immutable` BEFORE UPDATE OF `run_id`, `source`, `target`, `task_ids`, `artifact_ids`, `summary`, `created_at` ON `handoffs` BEGIN SELECT RAISE(ABORT, 'handoff routing fields are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `handoffs_no_delete` BEFORE DELETE ON `handoffs` BEGIN SELECT RAISE(ABORT, 'handoffs are never deleted'); END;--> statement-breakpoint
CREATE TRIGGER `agent_definition_revisions_no_update` BEFORE UPDATE ON `agent_definition_revisions` BEGIN SELECT RAISE(ABORT, 'agent_definition_revisions are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `agent_definition_revisions_no_delete` BEFORE DELETE ON `agent_definition_revisions` BEGIN SELECT RAISE(ABORT, 'agent_definition_revisions are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `invocations_definition_immutable` BEFORE UPDATE OF `run_id`, `plan_node_id`, `role`, `purpose`, `agent_definition_revision_id`, `continued_from_invocation_id`, `task_ids`, `alloc_cost_usd`, `alloc_tokens`, `alloc_attempts`, `allocation_source`, `final_reserve_use`, `created_at` ON `invocations` BEGIN SELECT RAISE(ABORT, 'invocation definition columns are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `invocations_no_delete` BEFORE DELETE ON `invocations` BEGIN SELECT RAISE(ABORT, 'invocations are never deleted'); END;--> statement-breakpoint
CREATE TRIGGER `attempts_definition_immutable` BEFORE UPDATE OF `invocation_id`, `run_id`, `plan_node_id`, `number`, `kind`, `start_mode`, `resumed_from_attempt_id`, `created_at` ON `attempts` BEGIN SELECT RAISE(ABORT, 'attempt definition columns are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `attempts_no_delete` BEFORE DELETE ON `attempts` BEGIN SELECT RAISE(ABORT, 'attempts are never deleted'); END;--> statement-breakpoint
CREATE TRIGGER `context_manifests_no_update` BEFORE UPDATE ON `context_manifests` BEGIN SELECT RAISE(ABORT, 'context_manifests are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `context_manifests_no_delete` BEFORE DELETE ON `context_manifests` BEGIN SELECT RAISE(ABORT, 'context_manifests are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `evaluations_no_update` BEFORE UPDATE ON `evaluations` BEGIN SELECT RAISE(ABORT, 'evaluations are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `evaluations_no_delete` BEFORE DELETE ON `evaluations` BEGIN SELECT RAISE(ABORT, 'evaluations are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `gates_definition_immutable` BEFORE UPDATE OF `run_id`, `plan_node_id`, `kind`, `acceptance_criterion_ids`, `opened_at` ON `gates` BEGIN SELECT RAISE(ABORT, 'gate definition columns are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `snapshots_no_update` BEFORE UPDATE ON `snapshots` BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `snapshots_no_delete` BEFORE DELETE ON `snapshots` BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `changesets_definition_immutable` BEFORE UPDATE OF `run_id`, `invocation_id`, `before_snapshot_id`, `after_snapshot_id`, `diff_artifact_id`, `created_at` ON `changesets` BEGIN SELECT RAISE(ABORT, 'changeset definition columns are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `publications_no_update` BEFORE UPDATE ON `publications` BEGIN SELECT RAISE(ABORT, 'publications are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `publications_no_delete` BEFORE DELETE ON `publications` BEGIN SELECT RAISE(ABORT, 'publications are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `budget_reservations_definition_immutable` BEFORE UPDATE OF `run_id`, `parent_type`, `parent_id`, `child_type`, `child_id`, `reserved_cost_usd`, `reserved_tokens`, `reserved_attempts`, `capacity_source`, `final_reserve_use`, `transferred_from_reservation_id`, `created_at` ON `budget_reservations` BEGIN SELECT RAISE(ABORT, 'budget_reservation allocation columns are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `budget_reservations_released_once` BEFORE UPDATE ON `budget_reservations` WHEN OLD.`status` = 'released' BEGIN SELECT RAISE(ABORT, 'a released budget_reservation never changes again'); END;--> statement-breakpoint
CREATE TRIGGER `budget_reservations_no_delete` BEFORE DELETE ON `budget_reservations` BEGIN SELECT RAISE(ABORT, 'budget_reservations are historical records'); END;--> statement-breakpoint
CREATE TRIGGER `capacity_leases_released_once` BEFORE UPDATE ON `capacity_leases` WHEN OLD.`status` = 'released' BEGIN SELECT RAISE(ABORT, 'a released capacity_lease never changes again'); END;--> statement-breakpoint
CREATE TRIGGER `usage_no_update` BEFORE UPDATE ON `usage` BEGIN SELECT RAISE(ABORT, 'usage is append-only'); END;--> statement-breakpoint
CREATE TRIGGER `usage_no_delete` BEFORE DELETE ON `usage` BEGIN SELECT RAISE(ABORT, 'usage is append-only'); END;--> statement-breakpoint
CREATE TRIGGER `conversation_messages_no_update` BEFORE UPDATE ON `conversation_messages` BEGIN SELECT RAISE(ABORT, 'conversation_messages are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `conversation_messages_no_delete` BEFORE DELETE ON `conversation_messages` BEGIN SELECT RAISE(ABORT, 'conversation_messages are append-only'); END;
