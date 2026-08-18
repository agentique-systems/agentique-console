CREATE TABLE `agent_profile_trust` (
	`workspace_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`revision` text NOT NULL,
	`trusted_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `profile_id`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_session_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`pattern` text DEFAULT 'hub_and_spoke' NOT NULL,
	`topology` text DEFAULT '{}' NOT NULL,
	`parent_agent_session_id` text,
	`parent_controller_seat` text,
	`depth` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_session_id`) REFERENCES `user_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_sessions_status" CHECK("agent_sessions"."status" IN ('open','archived'))
);
--> statement-breakpoint
CREATE TABLE `crons` (
	`id` text PRIMARY KEY NOT NULL,
	`user_session_id` text NOT NULL,
	`sdk_cron_id` text NOT NULL,
	`schedule` text NOT NULL,
	`prompt` text NOT NULL,
	`one_shot` integer DEFAULT false NOT NULL,
	`due_at` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "crons_status" CHECK("crons"."status" IN ('active','deleted'))
);
--> statement-breakpoint
CREATE INDEX `crons_session` ON `crons` (`user_session_id`,`status`);--> statement-breakpoint
CREATE TABLE `event_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`user_session_id` text,
	`agent_session_id` text,
	`media_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`workspace_id` text,
	`user_session_id` text,
	`agent_session_id` text,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_user_session` ON `events` (`user_session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_agent_session` ON `events` (`agent_session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `handoff_records` (
	`id` text PRIMARY KEY NOT NULL,
	`user_session_id` text NOT NULL,
	`agent_session_id` text,
	`message_id` text,
	`sender` text NOT NULL,
	`recipient` text NOT NULL,
	`profile_id` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`turn_id` text,
	`trigger` text NOT NULL,
	`parent_handoff_id` text,
	`root_handoff_id` text NOT NULL,
	`checkpoint` integer DEFAULT false NOT NULL,
	`core` text NOT NULL,
	`extension` text NOT NULL,
	`bytes` integer NOT NULL,
	`reference_warnings` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "handoffs_trigger" CHECK("handoff_records"."trigger" IN ('assignment','update','milestone','decision','failure','final','rotation','recovery'))
);
--> statement-breakpoint
CREATE INDEX `handoffs_user_created` ON `handoff_records` (`user_session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `handoffs_agent_recipient` ON `handoff_records` (`agent_session_id`,`recipient`,`created_at`);--> statement-breakpoint
CREATE TABLE `interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_session_id` text NOT NULL,
	`agent_session_id` text,
	`participant` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`urgency` text DEFAULT 'blocking' NOT NULL,
	`source` text DEFAULT 'agent' NOT NULL,
	`recommendation` text,
	`dedupe_key` text,
	`allow_free_text` integer DEFAULT false NOT NULL,
	`detached` integer DEFAULT false NOT NULL,
	`flushed_at` text,
	`payload` text NOT NULL,
	`response` text,
	`tool_use_id` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`user_session_id`) REFERENCES `user_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "interactions_kind" CHECK("interactions"."kind" IN ('question','plan_approval')),
	CONSTRAINT "interactions_status" CHECK("interactions"."status" IN ('pending','answered','rejected','dismissed','stale')),
	CONSTRAINT "interactions_urgency" CHECK("interactions"."urgency" IN ('blocking','deferred')),
	CONSTRAINT "interactions_source" CHECK("interactions"."source" IN ('agent','uncertainty','console'))
);
--> statement-breakpoint
CREATE INDEX `interactions_session_status` ON `interactions` (`user_session_id`,`status`);--> statement-breakpoint
CREATE INDEX `interactions_agent_open` ON `interactions` (`agent_session_id`,`status`,`urgency`);--> statement-breakpoint
CREATE TABLE `mailbox_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`user_session_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`sender` text NOT NULL,
	`recipient` text NOT NULL,
	`category` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`dedupe_key` text,
	`delivered_at` text,
	`acknowledged_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "mailbox_category" CHECK("mailbox_deliveries"."category" IN ('assignment','update','milestone','failure','final','decision')),
	CONSTRAINT "mailbox_status" CHECK("mailbox_deliveries"."status" IN ('queued','delivered','acknowledged','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_message_recipient` ON `mailbox_deliveries` (`message_id`,`recipient`);--> statement-breakpoint
CREATE INDEX `mailbox_recipient_status` ON `mailbox_deliveries` (`agent_session_id`,`recipient`,`status`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_kind` text NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`speaker_kind` text NOT NULL,
	`speaker_name` text NOT NULL,
	`to_name` text,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`payload` text,
	`turn_id` text,
	`created_at` text NOT NULL,
	CONSTRAINT "messages_session_kind" CHECK("messages"."session_kind" IN ('user','agent')),
	CONSTRAINT "messages_speaker_kind" CHECK("messages"."speaker_kind" IN ('operator','orchestrator','agent','system')),
	CONSTRAINT "messages_kind" CHECK("messages"."kind" IN ('message','notice','plan'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_session_seq` ON `messages` (`session_kind`,`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `messages_session` ON `messages` (`session_kind`,`session_id`);--> statement-breakpoint
CREATE TABLE `participants` (
	`agent_session_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`instructions` text NOT NULL,
	`model` text,
	`profile_id` text DEFAULT 'explorer' NOT NULL,
	`profile_snapshot` text DEFAULT '{}' NOT NULL,
	`ownership` text DEFAULT '[]' NOT NULL,
	`sdk_session_id` text,
	`last_active_at` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`turn_count` integer DEFAULT 0 NOT NULL,
	`context_tokens` integer DEFAULT 0 NOT NULL,
	`latest_handoff_id` text,
	`cumulative_cost_usd` real DEFAULT 0 NOT NULL,
	`cumulative_api_duration_ms` integer DEFAULT 0 NOT NULL,
	`last_decision_at` text,
	`worktree_path` text,
	`worktree_base_commit` text,
	`worktree_branch` text,
	`pattern_role` text,
	`ord` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`agent_session_id`, `name`),
	FOREIGN KEY (`agent_session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "participants_role" CHECK("participants"."role" IN ('orchestrator','agent'))
);
--> statement-breakpoint
CREATE TABLE `pattern_state` (
	`agent_session_id` text PRIMARY KEY NOT NULL,
	`rounds` integer DEFAULT 0 NOT NULL,
	`handoff_count` integer DEFAULT 0 NOT NULL,
	`last_progress_at` text,
	`recent_edges` text DEFAULT '[]' NOT NULL,
	`joins` text DEFAULT '{}' NOT NULL,
	`tripped` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`agent_session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `provider_entries_v2` (
	`ord` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_key` text NOT NULL,
	`session_id` text NOT NULL,
	`subpath` text DEFAULT '' NOT NULL,
	`uuid` text,
	`type` text NOT NULL,
	`entry` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `provider_entries_session` ON `provider_entries_v2` (`project_key`,`session_id`,`subpath`,`ord`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_entries_uuid` ON `provider_entries_v2` (`project_key`,`session_id`,`subpath`,`uuid`) WHERE uuid IS NOT NULL;--> statement-breakpoint
CREATE TABLE `run_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_session_id` text NOT NULL,
	`seq_from` integer NOT NULL,
	`seq_to` integer NOT NULL,
	`verdict` text NOT NULL,
	`document` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`user_session_id`) REFERENCES `user_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "run_summaries_status" CHECK("run_summaries"."status" IN ('proposed','accepted','changes_requested'))
);
--> statement-breakpoint
CREATE INDEX `run_summaries_session` ON `run_summaries` (`user_session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`blocker_task_id` text NOT NULL,
	`blocked_task_id` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`blocker_task_id`, `blocked_task_id`),
	CONSTRAINT "task_dependencies_source" CHECK("task_dependencies"."source" IN ('console','provider','migration'))
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text NOT NULL,
	`sdk_session_id` text NOT NULL,
	`sdk_task_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`user_session_id` text NOT NULL,
	`agent_session_id` text,
	`participant` text,
	`subject` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`active_form` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`owner` text,
	`blocks` text DEFAULT '[]' NOT NULL,
	`blocked_by` text DEFAULT '[]' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`sdk_session_id`, `sdk_task_id`),
	CONSTRAINT "tasks_status" CHECK("tasks"."status" IN ('pending','in_progress','completed','deleted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_console_id` ON `tasks` (`id`);--> statement-breakpoint
CREATE INDEX `tasks_user_session` ON `tasks` (`user_session_id`);--> statement-breakpoint
CREATE TABLE `usage_samples` (
	`id` text PRIMARY KEY NOT NULL,
	`user_session_id` text NOT NULL,
	`agent_session_id` text,
	`participant` text NOT NULL,
	`profile_id` text,
	`generation` integer NOT NULL,
	`turn_id` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`uncached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`model` text,
	`effort` text,
	`trigger` text,
	`duration_ms` integer,
	`api_duration_ms` integer,
	`sdk_duration_ms` integer,
	`status` text,
	`stop_reason` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_user_session` ON `usage_samples` (`user_session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `user_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text,
	`mode` text NOT NULL,
	`phase` text DEFAULT 'planning' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`purpose` text DEFAULT 'work' NOT NULL,
	`subject_key` text,
	`sdk_session_id` text,
	`sdk_generation` integer DEFAULT 0 NOT NULL,
	`sdk_turn_count` integer DEFAULT 0 NOT NULL,
	`context_tokens` integer DEFAULT 0 NOT NULL,
	`memory` text DEFAULT '' NOT NULL,
	`latest_handoff_id` text,
	`cumulative_cost_usd` real DEFAULT 0 NOT NULL,
	`cumulative_api_duration_ms` integer DEFAULT 0 NOT NULL,
	`run_state` text DEFAULT 'active' NOT NULL,
	`run_base_commit` text,
	`model` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "user_sessions_mode" CHECK("user_sessions"."mode" IN ('execute','plan_execute')),
	CONSTRAINT "user_sessions_phase" CHECK("user_sessions"."phase" IN ('planning','executing')),
	CONSTRAINT "user_sessions_status" CHECK("user_sessions"."status" IN ('open','archived')),
	CONSTRAINT "user_sessions_purpose" CHECK("user_sessions"."purpose" IN ('work','profile_manager')),
	CONSTRAINT "user_sessions_run_state" CHECK("user_sessions"."run_state" IN ('active','awaiting_signoff','completed'))
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`root_path` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_root_path_unique` ON `workspaces` (`root_path`);