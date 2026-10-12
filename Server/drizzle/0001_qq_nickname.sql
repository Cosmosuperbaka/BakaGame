CREATE TABLE `site_config` (
	`config_key` varchar(48) NOT NULL,
	`value` json NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `site_config_config_key` PRIMARY KEY(`config_key`)
);
--> statement-breakpoint
ALTER TABLE `user` ADD `qq_name` varchar(64);--> statement-breakpoint
ALTER TABLE `user` ADD `qq_name_checked_at` datetime(3);