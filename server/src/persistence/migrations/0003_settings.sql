CREATE TABLE `application_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`document` text NOT NULL
);
--> statement-breakpoint
UPDATE `schema_info` SET `version` = 4 WHERE `id` = 1;
