PRAGMA foreign_keys=OFF;--> statement-breakpoint
UPDATE participants SET pattern_role = COALESCE(pattern_role, CASE role WHEN 'orchestrator' THEN 'coordinator' ELSE 'specialist' END);--> statement-breakpoint
CREATE TABLE `__new_participants` (
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
	`pattern_role` text NOT NULL,
	`ord` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`agent_session_id`, `name`),
	FOREIGN KEY (`agent_session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "participants_role" CHECK("__new_participants"."role" IN ('orchestrator','agent'))
);
--> statement-breakpoint
INSERT INTO `__new_participants`("agent_session_id", "name", "role", "instructions", "model", "profile_id", "profile_snapshot", "ownership", "sdk_session_id", "last_active_at", "generation", "turn_count", "context_tokens", "latest_handoff_id", "cumulative_cost_usd", "cumulative_api_duration_ms", "last_decision_at", "worktree_path", "worktree_base_commit", "worktree_branch", "pattern_role", "ord", "created_at") SELECT "agent_session_id", "name", "role", "instructions", "model", "profile_id", "profile_snapshot", "ownership", "sdk_session_id", "last_active_at", "generation", "turn_count", "context_tokens", "latest_handoff_id", "cumulative_cost_usd", "cumulative_api_duration_ms", "last_decision_at", "worktree_path", "worktree_base_commit", "worktree_branch", "pattern_role", "ord", "created_at" FROM `participants`;--> statement-breakpoint
DROP TABLE `participants`;--> statement-breakpoint
ALTER TABLE `__new_participants` RENAME TO `participants`;--> statement-breakpoint
PRAGMA foreign_keys=ON;