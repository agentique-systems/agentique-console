ALTER TABLE `runs` ADD `execution` text;--> statement-breakpoint
ALTER TABLE `usage` ADD `cost_known` integer DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `runs_execution_immutable` BEFORE UPDATE OF `execution` ON `runs`
WHEN NEW.execution IS NOT OLD.execution
BEGIN SELECT RAISE(ABORT, 'Run execution selection is immutable'); END;
--> statement-breakpoint
UPDATE `schema_info` SET `version` = 2 WHERE `id` = 1;
