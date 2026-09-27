import type { ChatMessage } from "@/types";

// ==================== 故事共用的假数据 ====================
// 只供 Storybook 与截图使用，不被应用代码导入，不进入生产构建。

/** 固定的叙事时间原点，让聊天、提交记录等时间戳在每次截图中保持一致。 */
export const STORY_EPOCH = Date.UTC(2026, 8, 27, 12, 0, 0);

/** 以当前时刻为基准的截止时间。倒计时类组件读取真实时钟，截止时间必须在故事运行时计算。 */
export const fromNow = (ms: number) => Date.now() + ms;

/** 各游戏共用的玩家名单；最后一个故意取超长名字，用于检查截断与分数不被挤出。 */
export const STORY_PLAYERS = [
  { id: "player-host", name: "小布丁" },
  { id: "player-me", name: "海豹" },
  { id: "player-3", name: "桃子" },
  { id: "player-4", name: "阿澄" },
  { id: "player-5", name: "Kanade" },
  { id: "player-6", name: "北川" },
  { id: "player-long", name: "名称很长的玩家用于检查截断与分数排列" },
] as const;

export const STORY_SPECTATORS = [{ id: "spectator-1", name: "路人甲" }] as const;

let chatCounter = 0;

function message(
  playerId: string,
  playerName: string,
  text: string,
  offsetSeconds: number,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  chatCounter += 1;
  return {
    id: `chat-${chatCounter}`,
    playerId,
    playerName,
    text,
    createdAt: STORY_EPOCH + offsetSeconds * 1000,
    system: false,
    ...extra,
  };
}

const system = (text: string, offsetSeconds: number) => message("", "", text, offsetSeconds, { system: true });

/**
 * 一段覆盖常见形态的聊天：系统提示、本人与他人消息、@提及、长文本换行。
 * 系统提示只用三个游戏共有的建房、入房文案；各游戏特有的阶段提示由各自的故事补充。
 * `stickerPath` 取自 `loadStickerPacks()` 的真实清单，缺省时不插入表情消息。
 */
export function storyChat(myId: string = STORY_PLAYERS[1].id, stickerPath?: string): ChatMessage[] {
  const [host, me, peach, azumi] = STORY_PLAYERS;
  const self = STORY_PLAYERS.find((player) => player.id === myId) ?? me;
  return [
    system(`${host.name} 创建了房间`, 0),
    system(`${self.name} 加入了房间`, 12),
    message(host.id, host.name, "人齐了就开，第一把先熟悉一下规则", 20),
    message(self.id, self.name, `@${host.name} 我准备好了`, 31),
    message(peach.id, peach.name, "等我一下，马上回来", 44),
    ...(stickerPath ? [message(azumi.id, azumi.name, `@@sticker@@${stickerPath}`, 50)] : []),
    message(
      azumi.id,
      azumi.name,
      "这局我想试试把描述说得模糊一点，看看大家能不能从上一轮的线索里推出来，别一上来就把关键词说破了哈哈",
      58,
    ),
    message(self.id, self.name, "好的，开始吧", 76),
  ];
}

/** 纯色占位图（角色立绘、歌曲封面），用数据 URL 保证截图不依赖外网。 */
export function placeholderImage(label: string, hue: number, width = 120, height = 160): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="100%" height="100%" fill="hsl(${hue} 35% 72%)"/>`
    + `<text x="50%" y="54%" text-anchor="middle" font-family="serif" font-size="${Math.round(width / 4)}" fill="hsl(${hue} 30% 28%)">${label}</text>`
    + `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
