// ==================== 聊天 @提及 ====================
//
// 提及不进协议：`@名字` 就是一段普通聊天文本，服务端按原样存储与广播。
// 是否算作一次提及由客户端在渲染时对照当前房间名单判断，
// 因此改名、退房都不会留下失效的提及标记。

/** 触发提及候选浮层的字符 */
export const MENTION_TRIGGER = "@";

/** 一条消息切分后的片段：普通文本，或命中房间成员的提及。 */
export type MentionSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; playerId: string };

/**
 * 把消息切成文本与提及片段。
 *
 * 玩家名允许含空格，所以不能按空白切词，只能在每个 `@` 处
 * 拿现有名单做最长匹配 —— 这样「@小明」不会错误命中「@小明是谁」里的短名字，
 * 同时又能正确识别名字本身带空格的玩家。
 */
export function splitMentions(
  text: string,
  players: Array<{ id: string; name: string }>,
): MentionSegment[] {
  if (!text.includes(MENTION_TRIGGER) || players.length === 0) {
    return [{ kind: "text", text }];
  }

  // 长名字优先，避免短名字抢先匹配掉长名字的前缀。
  const candidates = [...players]
    .filter((player) => player.name.length > 0)
    .sort((left, right) => right.name.length - left.name.length);

  const segments: MentionSegment[] = [];
  let plain = "";
  let cursor = 0;

  const flushPlain = () => {
    if (plain) {
      segments.push({ kind: "text", text: plain });
      plain = "";
    }
  };

  while (cursor < text.length) {
    if (text[cursor] !== MENTION_TRIGGER) {
      plain += text[cursor];
      cursor += 1;
      continue;
    }

    const rest = text.slice(cursor + 1);
    const matched = candidates.find((player) => rest.startsWith(player.name));

    if (!matched) {
      plain += text[cursor];
      cursor += 1;
      continue;
    }

    flushPlain();
    segments.push({
      kind: "mention",
      text: `${MENTION_TRIGGER}${matched.name}`,
      playerId: matched.id,
    });
    cursor += 1 + matched.name.length;
  }

  flushPlain();
  return segments;
}

/** 该消息是否提及了指定玩家。 */
export function mentionsPlayer(
  text: string,
  playerId: string,
  players: Array<{ id: string; name: string }>,
): boolean {
  return splitMentions(text, players).some(
    (segment) => segment.kind === "mention" && segment.playerId === playerId,
  );
}

/**
 * 光标前正在输入的提及查询。
 *
 * 只在「`@` 之后到光标之间还没跨越空白」时才算正在输入提及，
 * 因此已经完成的 `@名字 ` 不会一直把候选浮层挂着。
 */
export function readMentionQuery(
  value: string,
  caret: number,
): { query: string; start: number } | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf(MENTION_TRIGGER);

  if (at < 0) return null;

  const query = before.slice(at + 1);

  // 名字可以带空格，但连续空白通常意味着这次提及已经结束。
  if (/\s\s|\n/.test(query)) return null;

  return { query, start: at };
}

/** 按当前查询过滤候选玩家，空查询时给出全部。 */
export function filterMentionCandidates<T extends { name: string }>(
  players: T[],
  query: string,
): T[] {
  if (!query) return players;
  const needle = query.toLowerCase();
  return players.filter((player) => player.name.toLowerCase().includes(needle));
}

/** 把选中的候选写回输入框，并返回新光标位置。 */
export function applyMention(
  value: string,
  start: number,
  caret: number,
  name: string,
): { value: string; caret: number } {
  const inserted = `${MENTION_TRIGGER}${name} `;
  const next = value.slice(0, start) + inserted + value.slice(caret);
  return { value: next, caret: start + inserted.length };
}
