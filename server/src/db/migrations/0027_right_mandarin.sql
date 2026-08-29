PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_orchestration_state_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_session_id` text NOT NULL,
	`revision` integer NOT NULL,
	`trigger` text NOT NULL,
	`strategy` text DEFAULT '' NOT NULL,
	`strategy_why` text DEFAULT '' NOT NULL,
	`uncertainties` text DEFAULT '[]' NOT NULL,
	`assumptions` text DEFAULT '[]' NOT NULL,
	`risks` text DEFAULT '[]' NOT NULL,
	`note` text,
	`completion` text,
	`objective_assessment` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_session_id`) REFERENCES `user_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "orchestration_state_trigger" CHECK("__new_orchestration_state_revisions"."trigger" IN ('commission','discovery','alarm','direction_change','completion','operator','objective_assessment'))
);
--> statement-breakpoint
INSERT INTO `__new_orchestration_state_revisions`("id", "user_session_id", "revision", "trigger", "strategy", "strategy_why", "uncertainties", "assumptions", "risks", "note", "completion", "objective_assessment", "created_at") SELECT "id", "user_session_id", "revision", "trigger", "strategy", "strategy_why", "uncertainties", "assumptions", "risks", "note", "completion", NULL, "created_at" FROM `orchestration_state_revisions`;--> statement-breakpoint
DROP TABLE `orchestration_state_revisions`;--> statement-breakpoint
ALTER TABLE `__new_orchestration_state_revisions` RENAME TO `orchestration_state_revisions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `orchestration_state_session` ON `orchestration_state_revisions` (`user_session_id`,`revision`);--> statement-breakpoint
ALTER TABLE `projects` ADD `objective_document` text;--> statement-breakpoint
-- Preserve operator authority deterministically: the earliest operator
-- message from a work session on the project wins. Legacy intent is only the
-- fallback for projects without an authoritative message (including old
-- internal/profile-manager projects and incomplete histories). Never merge or
-- model-synthesize multiple messages.
UPDATE `projects`
SET `objective_document` = COALESCE(
  (
    SELECT m.`text`
    FROM `user_sessions` us
    JOIN `messages` m ON m.`session_kind` = 'user' AND m.`session_id` = us.`id`
    WHERE us.`project_id` = `projects`.`id`
      AND us.`purpose` = 'work'
      AND m.`speaker_kind` = 'operator'
      AND trim(m.`text`) <> ''
    ORDER BY m.`created_at`, us.`created_at`, m.`seq`, us.`id`
    LIMIT 1
  ),
  `intent_document`
)
WHERE `objective_document` IS NULL;
