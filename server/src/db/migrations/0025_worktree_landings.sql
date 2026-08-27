CREATE TABLE `worktree_landings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_session_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`agent` text NOT NULL,
	`branch` text NOT NULL,
	`base_commit` text NOT NULL,
	`merge_commit` text NOT NULL,
	`files_changed` integer NOT NULL,
	`artifact_id` text,
	`landed_at` text NOT NULL,
	`invalidated_at` text,
	`invalidated_reason` text,
	`salvage_ref` text,
	FOREIGN KEY (`user_session_id`) REFERENCES `user_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_worktree_landings_user` ON `worktree_landings` (`user_session_id`);