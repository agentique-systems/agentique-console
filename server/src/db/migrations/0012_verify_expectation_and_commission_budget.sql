ALTER TABLE `agent_sessions` ADD `budget_usd` real;--> statement-breakpoint
ALTER TABLE `requirement_nodes` ADD `verify_expectation` text;--> statement-breakpoint
CREATE INDEX `usage_agent_session` ON `usage_samples` (`agent_session_id`);