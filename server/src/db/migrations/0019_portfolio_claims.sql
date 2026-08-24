CREATE TABLE `workstream_links` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_session_id` text NOT NULL,
	`consumer_agent_session_id` text NOT NULL,
	`producer_agent_session_id` text NOT NULL,
	`subject` text NOT NULL,
	`created_by` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	`released_at` text,
	`released_by` text,
	`release_note` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workstream_links_live_pair` ON `workstream_links` (`consumer_agent_session_id`,`producer_agent_session_id`,`subject`) WHERE released_at IS NULL;--> statement-breakpoint
CREATE INDEX `workstream_links_project` ON `workstream_links` (`project_id`,`released_at`);--> statement-breakpoint
CREATE INDEX `workstream_links_producer` ON `workstream_links` (`producer_agent_session_id`);--> statement-breakpoint
CREATE INDEX `workstream_links_consumer` ON `workstream_links` (`consumer_agent_session_id`);--> statement-breakpoint
ALTER TABLE `agents` ADD `shared_ownership` text DEFAULT '[]' NOT NULL;