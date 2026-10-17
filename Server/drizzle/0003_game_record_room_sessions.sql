DELETE FROM `game_record_player`;
--> statement-breakpoint
DELETE FROM `game_record`;
--> statement-breakpoint
ALTER TABLE `game_record` DROP COLUMN `round_number`, DROP COLUMN `summary`, DROP COLUMN `timeline`;
--> statement-breakpoint
ALTER TABLE `game_record` ADD COLUMN `round_count` int NOT NULL;
--> statement-breakpoint
CREATE TABLE `game_record_round` (
	`record_id` varchar(36) NOT NULL,
	`round_number` int NOT NULL,
	`started_at` datetime(3) NOT NULL,
	`ended_at` datetime(3) NOT NULL,
	`player_count` int NOT NULL,
	`players` json NOT NULL,
	`summary` json NOT NULL,
	`timeline` json NOT NULL,
	CONSTRAINT `game_record_round_record_id_round_number_pk` PRIMARY KEY(`record_id`,`round_number`)
);
--> statement-breakpoint
ALTER TABLE `game_record_round` ADD CONSTRAINT `game_record_round_record_id_game_record_id_fk` FOREIGN KEY (`record_id`) REFERENCES `game_record`(`id`) ON DELETE cascade ON UPDATE no action;
