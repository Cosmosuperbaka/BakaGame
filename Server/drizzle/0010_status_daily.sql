CREATE TABLE `status_daily` (
	`component_id` varchar(24) NOT NULL,
	`day` varchar(10) NOT NULL,
	`total` int NOT NULL,
	`operational` int NOT NULL,
	`degraded` int NOT NULL,
	`unknown` int NOT NULL,
	CONSTRAINT `status_daily_component_id_day_pk` PRIMARY KEY(`component_id`,`day`)
);
--> statement-breakpoint
CREATE INDEX `status_daily_day_idx` ON `status_daily` (`day`);