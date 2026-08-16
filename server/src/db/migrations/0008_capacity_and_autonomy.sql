ALTER TABLE `user_sessions` ADD `paused_until` text;--> statement-breakpoint
ALTER TABLE `user_sessions` ADD `pause_reason` text;--> statement-breakpoint
ALTER TABLE `user_sessions` ADD `budget_usd` real;--> statement-breakpoint
ALTER TABLE `user_sessions` ADD `autonomy` text DEFAULT 'standard' NOT NULL;