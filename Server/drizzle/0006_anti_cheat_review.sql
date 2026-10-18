CREATE TABLE `cee_anti_cheat_review` (
	`id` varchar(36) NOT NULL,
	`room_id` varchar(8) NOT NULL,
	`room_created_at` datetime(3) NOT NULL,
	`round_number` int NOT NULL,
	`player_id` varchar(64) NOT NULL,
	`player_name` varchar(64) NOT NULL,
	`user_id` varchar(64),
	`client_type` varchar(16) NOT NULL,
	`score` int NOT NULL,
	`reasons` json NOT NULL,
	`features` json NOT NULL,
	`status` varchar(16) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `cee_anti_cheat_review_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `cee_ac_review_created_idx` ON `cee_anti_cheat_review` (`created_at`);--> statement-breakpoint
CREATE INDEX `cee_ac_review_status_idx` ON `cee_anti_cheat_review` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `cee_ac_review_user_idx` ON `cee_anti_cheat_review` (`user_id`);