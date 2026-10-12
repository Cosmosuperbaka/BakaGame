CREATE TABLE `account` (
	`id` varchar(64) NOT NULL,
	`account_id` varchar(255) NOT NULL,
	`provider_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` datetime(3),
	`refresh_token_expires_at` datetime(3),
	`scope` text,
	`password` text,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `account_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`actor_id` varchar(64),
	`action` varchar(64) NOT NULL,
	`target_type` varchar(32) NOT NULL,
	`target_id` varchar(128) NOT NULL,
	`detail` json,
	`ip_address` varchar(64),
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `audit_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `feedback` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`kind` varchar(16) NOT NULL,
	`title` varchar(120) NOT NULL,
	`content` text NOT NULL,
	`status` varchar(16) NOT NULL,
	`page` varchar(255),
	`user_agent` varchar(512),
	`sentry_event_id` varchar(64),
	`last_reply_at` datetime(3),
	`user_seen_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `feedback_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `feedback_reply` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`feedback_id` varchar(36) NOT NULL,
	`author_id` varchar(64),
	`content` text NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `feedback_reply_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `game_record` (
	`id` varchar(36) NOT NULL,
	`game` varchar(16) NOT NULL,
	`room_id` varchar(32) NOT NULL,
	`round_number` int NOT NULL,
	`started_at` datetime(3) NOT NULL,
	`ended_at` datetime(3) NOT NULL,
	`player_count` int NOT NULL,
	`summary` json NOT NULL,
	`timeline` json NOT NULL,
	CONSTRAINT `game_record_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `game_record_player` (
	`record_id` varchar(36) NOT NULL,
	`player_id` varchar(64) NOT NULL,
	`user_id` varchar(64),
	`name` varchar(64) NOT NULL,
	`score` int NOT NULL,
	CONSTRAINT `game_record_player_record_id_player_id_pk` PRIMARY KEY(`record_id`,`player_id`)
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` varchar(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`token` varchar(255) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`ip_address` varchar(64),
	`user_agent` text,
	`user_id` varchar(64) NOT NULL,
	`impersonated_by` varchar(64),
	CONSTRAINT `session_id` PRIMARY KEY(`id`),
	CONSTRAINT `session_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `site_page_daily` (
	`day` varchar(10) NOT NULL,
	`path` varchar(64) NOT NULL,
	`views` int NOT NULL,
	CONSTRAINT `site_page_daily_day_path_pk` PRIMARY KEY(`day`,`path`)
);
--> statement-breakpoint
CREATE TABLE `site_visit_daily` (
	`day` varchar(10) NOT NULL,
	`visitor_hash` varchar(32) NOT NULL,
	`user_id` varchar(64),
	`views` int NOT NULL,
	CONSTRAINT `site_visit_daily_day_visitor_hash_pk` PRIMARY KEY(`day`,`visitor_hash`)
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` varchar(64) NOT NULL,
	`name` varchar(64) NOT NULL,
	`email` varchar(128) NOT NULL,
	`email_verified` boolean NOT NULL DEFAULT false,
	`image` text,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`role` varchar(16),
	`banned` boolean DEFAULT false,
	`ban_reason` text,
	`ban_expires` datetime(3),
	`qq_number` varchar(16) NOT NULL,
	`show_qq` boolean NOT NULL DEFAULT false,
	`avatar_hash` varchar(64),
	`avatar_checked_at` datetime(3),
	CONSTRAINT `user_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_email_unique` UNIQUE(`email`),
	CONSTRAINT `user_qq_number_unique` UNIQUE(`qq_number`)
);
--> statement-breakpoint
CREATE TABLE `user_setting` (
	`user_id` varchar(64) NOT NULL,
	`setting_key` varchar(48) NOT NULL,
	`value` json NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `user_setting_user_id_setting_key_pk` PRIMARY KEY(`user_id`,`setting_key`)
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` varchar(64) NOT NULL,
	`identifier` varchar(255) NOT NULL,
	`value` text NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `verification_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `word_pair` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`word_a` varchar(64) NOT NULL,
	`word_b` varchar(64) NOT NULL,
	`use_count` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL,
	`last_used_at` datetime(3) NOT NULL,
	CONSTRAINT `word_pair_id` PRIMARY KEY(`id`),
	CONSTRAINT `word_pair_unique` UNIQUE(`word_a`,`word_b`)
);
--> statement-breakpoint
ALTER TABLE `account` ADD CONSTRAINT `account_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `feedback` ADD CONSTRAINT `feedback_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `feedback_reply` ADD CONSTRAINT `feedback_reply_feedback_id_feedback_id_fk` FOREIGN KEY (`feedback_id`) REFERENCES `feedback`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `feedback_reply` ADD CONSTRAINT `feedback_reply_author_id_user_id_fk` FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `game_record_player` ADD CONSTRAINT `game_record_player_record_id_game_record_id_fk` FOREIGN KEY (`record_id`) REFERENCES `game_record`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `game_record_player` ADD CONSTRAINT `game_record_player_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `session` ADD CONSTRAINT `session_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_setting` ADD CONSTRAINT `user_setting_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE INDEX `audit_log_created_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_actor_idx` ON `audit_log` (`actor_id`);--> statement-breakpoint
CREATE INDEX `audit_log_action_idx` ON `audit_log` (`action`);--> statement-breakpoint
CREATE INDEX `feedback_user_idx` ON `feedback` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `feedback_status_idx` ON `feedback` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `feedback_reply_feedback_idx` ON `feedback_reply` (`feedback_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `game_record_ended_idx` ON `game_record` (`ended_at`);--> statement-breakpoint
CREATE INDEX `game_record_game_ended_idx` ON `game_record` (`game`,`ended_at`);--> statement-breakpoint
CREATE INDEX `game_record_room_idx` ON `game_record` (`room_id`);--> statement-breakpoint
CREATE INDEX `game_record_player_user_idx` ON `game_record_player` (`user_id`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);