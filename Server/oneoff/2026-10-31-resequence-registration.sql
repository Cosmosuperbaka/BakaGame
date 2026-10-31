-- 一次性数据订正：把 TiDB 自增跳号写坏的注册序号重排为按建号时间的连续名次，并补发先行者。
--
-- 背景：`user_registration.seq` 原先是 AUTO_INCREMENT，TiDB 按缓存段预取（AUTO_ID_CACHE
-- 默认一段 30000），第 5 个真实账号就拿到 30001，先行者「前 N 名」的判定被跳号顶穿。
-- 代码侧已改为应用层分配（`Server/src/infrastructure/db/RegistrationRepository.ts`），
-- 本脚本只修库里的存量行。
--
-- 执行：`cd Server && bun run db:oneoff oneoff/2026-10-31-resequence-registration.sql --dry-run`
-- 核对语句后去掉 `--dry-run` 在每个环境各跑一次，随后删除本文件（规则见 Server/docs/Database.md）。
-- 可重跑：重排结果不变，补发与佩戴都按「尚缺才补」判定。

-- 1. 先整体挪到高位，避开重排过程中的主键冲突。
UPDATE `user_registration` SET `seq` = `seq` + 1000000;

-- 2. 按建号时间重排为 1..N（同毫秒用 id 兜底，与启动回填的顺序一致）。
UPDATE `user_registration` r
  JOIN (
    SELECT r2.`user_id` AS user_id,
           ROW_NUMBER() OVER (ORDER BY u.`created_at` ASC, u.`id` ASC) AS rn
      FROM `user_registration` r2
      JOIN `user` u ON u.`id` = r2.`user_id`
  ) ordered ON ordered.user_id = r.`user_id`
   SET r.`seq` = ordered.rn;

-- 3. 目录行兜底：`user_badge` 的外键指向 `badge`，空环境里也要能一次跑完。
--    文案与 `Server/src/shared/Badges.ts` 的 BADGE_CATALOG 保持一致。
INSERT INTO `badge` (`id`, `label`, `description`, `sort_order`)
VALUES ('pioneer', '先行者', 'BakaGame的第X位注册用户', 3)
ON DUPLICATE KEY UPDATE `label` = VALUES(`label`),
                        `description` = VALUES(`description`),
                        `sort_order` = VALUES(`sort_order`);

-- 4. 补发先行者：重排后名次在名额内、还没有这枚徽章的账号各补一枚。
--    名额 = PIONEER_BADGE_LIMIT。
INSERT INTO `user_badge` (`user_id`, `badge_id`, `granted_by`, `granted_at`)
SELECT r.`user_id`, 'pioneer', NULL, NOW(3)
  FROM `user_registration` r
 WHERE r.`seq` <= 1000
   AND NOT EXISTS (
     SELECT 1 FROM `user_badge` b
      WHERE b.`user_id` = r.`user_id` AND b.`badge_id` = 'pioneer'
   );

-- 5. 佩戴位空着的补上这枚；玩家自己选过徽章的不覆盖（与 BadgeRepository.grant 同口径）。
UPDATE `user` u
  JOIN `user_badge` b ON b.`user_id` = u.`id` AND b.`badge_id` = 'pioneer'
   SET u.`equipped_badge` = 'pioneer'
 WHERE u.`equipped_badge` IS NULL;
