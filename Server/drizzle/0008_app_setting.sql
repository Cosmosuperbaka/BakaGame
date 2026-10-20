CREATE TABLE `app_setting` (
	`setting_key` varchar(48) NOT NULL,
	`value` text NOT NULL,
	`updated_by` varchar(64),
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `app_setting_setting_key` PRIMARY KEY(`setting_key`)
);
