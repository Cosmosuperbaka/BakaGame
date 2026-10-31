-- 排位审计五张表：评级、系列赛、席位、单局、猜测。按 Server/docs/Database.md 的一次性脚本流程在各环境执行后删除。
CREATE TABLE `cee_ranked_rating` (
	`user_id` varchar(64) NOT NULL,
	`rating` double NOT NULL,
	`rd` double NOT NULL,
	`series_played` int NOT NULL DEFAULT 0,
	`wins` int NOT NULL DEFAULT 0,
	`losses` int NOT NULL DEFAULT 0,
	`draws` int NOT NULL DEFAULT 0,
	`bot_rated_day` varchar(10),
	`bot_rated_count` int NOT NULL DEFAULT 0,
	`last_played_at` datetime(3),
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `cee_ranked_rating_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `cee_ranked_series` (
	`id` varchar(36) NOT NULL,
	`ruleset` varchar(16) NOT NULL,
	`tier` varchar(8) NOT NULL,
	`answer_ids` json NOT NULL,
	`started_at` datetime(3) NOT NULL,
	`ended_at` datetime(3) NOT NULL,
	`end_reason` varchar(16) NOT NULL,
	`rated` boolean NOT NULL,
	`unrated_reason` varchar(32),
	`bot` boolean NOT NULL,
	`bot_entry` varchar(16),
	CONSTRAINT `cee_ranked_series_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `cee_ranked_series_player` (
	`series_id` varchar(36) NOT NULL,
	`seat` int NOT NULL,
	`user_id` varchar(64),
	`name` varchar(64) NOT NULL,
	`client_type` varchar(16),
	`client_version` varchar(32),
	`bot_persona` varchar(16),
	`bot_target_rating` double,
	`bot_strength_rating` double,
	`queue_wait_ms` int,
	`points` double NOT NULL,
	`score` double NOT NULL,
	`placement` boolean NOT NULL,
	`rating_before` double,
	`rating_after` double,
	`rd_before` double,
	`rd_after` double,
	CONSTRAINT `cee_ranked_series_player_series_id_seat_pk` PRIMARY KEY(`series_id`,`seat`)
);
--> statement-breakpoint
CREATE TABLE `cee_ranked_game` (
	`series_id` varchar(36) NOT NULL,
	`number` int NOT NULL,
	`answer_character_id` int NOT NULL,
	`answer_name` varchar(128) NOT NULL,
	`winner_seat` int,
	`end_reason` varchar(16) NOT NULL,
	`attempts_0` int NOT NULL,
	`attempts_1` int NOT NULL,
	`overtime` boolean NOT NULL,
	`started_at` datetime(3) NOT NULL,
	`ended_at` datetime(3) NOT NULL,
	CONSTRAINT `cee_ranked_game_series_id_number_pk` PRIMARY KEY(`series_id`,`number`)
);
--> statement-breakpoint
CREATE TABLE `cee_ranked_guess` (
	`series_id` varchar(36) NOT NULL,
	`game_number` int NOT NULL,
	`seat` int NOT NULL,
	`attempt` int NOT NULL,
	`character_id` int NOT NULL,
	`character_name` varchar(128) NOT NULL,
	`correct` boolean NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`client_type` varchar(16),
	`searched_at` datetime(3),
	`search_matched` boolean,
	CONSTRAINT `cee_ranked_guess_series_id_game_number_seat_attempt_pk` PRIMARY KEY(`series_id`,`game_number`,`seat`,`attempt`)
);
--> statement-breakpoint
ALTER TABLE `cee_ranked_rating` ADD CONSTRAINT `cee_ranked_rating_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cee_ranked_series_player` ADD CONSTRAINT `cee_ranked_series_player_series_id_cee_ranked_series_id_fk` FOREIGN KEY (`series_id`) REFERENCES `cee_ranked_series`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cee_ranked_series_player` ADD CONSTRAINT `cee_ranked_series_player_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cee_ranked_game` ADD CONSTRAINT `cee_ranked_game_series_id_cee_ranked_series_id_fk` FOREIGN KEY (`series_id`) REFERENCES `cee_ranked_series`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cee_ranked_guess` ADD CONSTRAINT `cee_ranked_guess_series_id_cee_ranked_series_id_fk` FOREIGN KEY (`series_id`) REFERENCES `cee_ranked_series`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `cee_ranked_rating_rating_idx` ON `cee_ranked_rating` (`rating`);--> statement-breakpoint
CREATE INDEX `cee_ranked_series_ended_idx` ON `cee_ranked_series` (`ended_at`);--> statement-breakpoint
CREATE INDEX `cee_ranked_series_player_user_idx` ON `cee_ranked_series_player` (`user_id`);
