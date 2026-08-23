CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text,
	`intent_document` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `projects` ("id", "workspace_id", "title", "intent_document", "created_at")
	SELECT 'proj_' || "id", "workspace_id", NULL, NULL, "created_at" FROM `user_sessions`;
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text,
	`mode` text NOT NULL,
	`phase` text DEFAULT 'planning' NOT NULL,
	`lifecycle` text DEFAULT 'open' NOT NULL,
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
	`paused_until` text,
	`pause_reason` text,
	`budget_usd` real,
	`autonomy` text DEFAULT 'standard' NOT NULL,
	`model` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "user_sessions_mode" CHECK("__new_user_sessions"."mode" IN ('execute','plan_execute')),
	CONSTRAINT "user_sessions_phase" CHECK("__new_user_sessions"."phase" IN ('planning','executing')),
	CONSTRAINT "user_sessions_lifecycle" CHECK("__new_user_sessions"."lifecycle" IN ('open','archived')),
	CONSTRAINT "user_sessions_purpose" CHECK("__new_user_sessions"."purpose" IN ('work','profile_manager')),
	CONSTRAINT "user_sessions_run_state" CHECK("__new_user_sessions"."run_state" IN ('active','awaiting_signoff','completed'))
);
--> statement-breakpoint
INSERT INTO `__new_user_sessions`("id", "workspace_id", "project_id", "title", "mode", "phase", "lifecycle", "purpose", "subject_key", "sdk_session_id", "sdk_generation", "sdk_turn_count", "context_tokens", "memory", "latest_handoff_id", "cumulative_cost_usd", "cumulative_api_duration_ms", "run_state", "run_base_commit", "paused_until", "pause_reason", "budget_usd", "autonomy", "model", "created_at", "updated_at")
	SELECT "id", "workspace_id", 'proj_' || "id", "title", "mode", "phase", "lifecycle", "purpose", "subject_key", "sdk_session_id", "sdk_generation", "sdk_turn_count", "context_tokens", "memory", "latest_handoff_id", "cumulative_cost_usd", "cumulative_api_duration_ms", "run_state", "run_base_commit", "paused_until", "pause_reason", "budget_usd", "autonomy", "model", "created_at", "updated_at" FROM `user_sessions`;
--> statement-breakpoint
DROP TABLE `user_sessions`;--> statement-breakpoint
ALTER TABLE `__new_user_sessions` RENAME TO `user_sessions`;--> statement-breakpoint
CREATE TABLE `__new_requirement_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_session_id` text NOT NULL,
	`revision` integer NOT NULL,
	`base_revision` integer NOT NULL,
	`document` text NOT NULL,
	`graph` text NOT NULL,
	`change_note` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`origin` text DEFAULT 'main' NOT NULL,
	`interaction_id` text,
	`created_at` text NOT NULL,
	`approved_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_session_id`) REFERENCES `user_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "requirement_revisions_status" CHECK("__new_requirement_revisions"."status" IN ('draft','approved','superseded','rejected')),
	CONSTRAINT "requirement_revisions_origin" CHECK("__new_requirement_revisions"."origin" IN ('main','operator_edited'))
);
--> statement-breakpoint
INSERT INTO `__new_requirement_revisions`("id", "project_id", "user_session_id", "revision", "base_revision", "document", "graph", "change_note", "status", "origin", "interaction_id", "created_at", "approved_at")
	SELECT "id", 'proj_' || "user_session_id", "user_session_id", "revision", "revision" - 1, "document", "graph", "change_note", "status", "origin", "interaction_id", "created_at", "approved_at" FROM `requirement_revisions`;
--> statement-breakpoint
DROP TABLE `requirement_revisions`;--> statement-breakpoint
ALTER TABLE `__new_requirement_revisions` RENAME TO `requirement_revisions`;--> statement-breakpoint
CREATE INDEX `requirement_revisions_project` ON `requirement_revisions` (`project_id`,`revision`);--> statement-breakpoint
CREATE TABLE `__new_requirement_nodes` (
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`parent_id` text,
	`ord` integer NOT NULL,
	`statement` text NOT NULL,
	`composition` text DEFAULT 'all' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`origin` text DEFAULT 'committed' NOT NULL,
	`introduced_in_revision` integer NOT NULL,
	`retired_in_revision` integer,
	`refined_by_agent_session_id` text,
	`verify_expectation` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`project_id`, `id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "requirement_nodes_status" CHECK("__new_requirement_nodes"."status" IN ('open','satisfied','violated','infeasible','retired')),
	CONSTRAINT "requirement_nodes_composition" CHECK("__new_requirement_nodes"."composition" IN ('all','any')),
	CONSTRAINT "requirement_nodes_origin" CHECK("__new_requirement_nodes"."origin" IN ('committed','refinement'))
);
--> statement-breakpoint
INSERT INTO `__new_requirement_nodes`("id", "project_id", "parent_id", "ord", "statement", "composition", "status", "origin", "introduced_in_revision", "retired_in_revision", "refined_by_agent_session_id", "verify_expectation", "created_at", "updated_at")
	SELECT "id", 'proj_' || "user_session_id", "parent_id", "ord", "statement", "composition", "status", "origin", "introduced_in_revision", "retired_in_revision", "refined_by_agent_session_id", "verify_expectation", "created_at", "updated_at" FROM `requirement_nodes`;
--> statement-breakpoint
DROP TABLE `requirement_nodes`;--> statement-breakpoint
ALTER TABLE `__new_requirement_nodes` RENAME TO `requirement_nodes`;--> statement-breakpoint
CREATE INDEX `requirement_nodes_live` ON `requirement_nodes` (`project_id`,`retired_in_revision`);--> statement-breakpoint
CREATE TABLE `__new_requirement_status_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_session_id` text NOT NULL,
	`requirement_id` text NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`verified_by` text NOT NULL,
	`actor` text NOT NULL,
	`agent_session_id` text,
	`at_revision` integer NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	CONSTRAINT "requirement_status_changes_verified_by" CHECK("__new_requirement_status_changes"."verified_by" IN ('self','independent','operator','console'))
);
--> statement-breakpoint
INSERT INTO `__new_requirement_status_changes`("id", "project_id", "user_session_id", "requirement_id", "from_status", "to_status", "evidence", "verified_by", "actor", "agent_session_id", "at_revision", "note", "created_at")
	SELECT "id", 'proj_' || "user_session_id", "user_session_id", "requirement_id", "from_status", "to_status", "evidence", "verified_by", "actor", "agent_session_id", "at_revision", "note", "created_at" FROM `requirement_status_changes`;
--> statement-breakpoint
DROP TABLE `requirement_status_changes`;--> statement-breakpoint
ALTER TABLE `__new_requirement_status_changes` RENAME TO `requirement_status_changes`;--> statement-breakpoint
CREATE INDEX `requirement_status_changes_req` ON `requirement_status_changes` (`project_id`,`requirement_id`,`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
