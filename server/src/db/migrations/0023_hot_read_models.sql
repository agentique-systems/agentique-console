DROP INDEX `requirement_status_changes_req`;--> statement-breakpoint
CREATE INDEX `requirement_status_changes_project_ord` ON `requirement_status_changes` (`project_id`,`ord`);--> statement-breakpoint
CREATE INDEX `requirement_status_changes_reversals` ON `requirement_status_changes` (`project_id`,`ord`) WHERE from_status IN ('satisfied','violated','infeasible') AND to_status != from_status AND actor != 'console';--> statement-breakpoint
CREATE INDEX `requirement_status_changes_req` ON `requirement_status_changes` (`project_id`,`requirement_id`,`ord`);--> statement-breakpoint
ALTER TABLE `requirement_nodes` ADD `latest_change_id` text;--> statement-breakpoint
ALTER TABLE `requirement_nodes` ADD `latest_change_ord` integer;--> statement-breakpoint
CREATE INDEX `user_sessions_project` ON `user_sessions` (`project_id`);--> statement-breakpoint
-- Backfill the latest-claim pointers from the authoritative journal: for every
-- node the max-`ord` status change of its (project, requirement) — `ord` is the
-- shared invalidation clock, so "latest" is a deterministic integer comparison
-- (rowid breaks the tie defensively for pre-0014 rows). Nodes with no journal
-- rows stay NULL: their status has been "open" since insertion. Runs after the
-- index creation above so the correlated subqueries are keyed lookups.
UPDATE `requirement_nodes` SET
	`latest_change_id` = (SELECT c.`id` FROM `requirement_status_changes` c
		WHERE c.`project_id` = `requirement_nodes`.`project_id` AND c.`requirement_id` = `requirement_nodes`.`id`
		ORDER BY c.`ord` DESC, c.`rowid` DESC LIMIT 1),
	`latest_change_ord` = (SELECT c.`ord` FROM `requirement_status_changes` c
		WHERE c.`project_id` = `requirement_nodes`.`project_id` AND c.`requirement_id` = `requirement_nodes`.`id`
		ORDER BY c.`ord` DESC, c.`rowid` DESC LIMIT 1);
