import { AppError } from "../domain/Errors";
import lexiconData from "./SensitiveLexicon.json";
import whitelistData from "./SensitiveWhitelist.json";
import { toSimplified } from "./ChineseConverter";

/**
 * 敏感词检测：服务端是唯一权威，所有「用户输入且其他用户可见」的文本在写入前都过这里。
 * 词表启动时构建一次自动机，检测耗时与文本长度线性相关；命中只返回布尔，绝不回显命中的词。
 */

export const SENSITIVE_TEXT_MESSAGE = "内容包含不允许的词语，请修改";

const CJK_OR_OTHER = 0;
const ASCII_ALNUM = 1;

const isAsciiAlnum = (char: string): boolean => /^[a-z0-9]$/.test(char);
const isKept = (char: string): boolean => /^[\p{L}\p{N}]$/u.test(char);

interface NormalizedText {
  /** 只保留字母数字（含汉字）的码点序列。 */
  chars: string[];
  /** 该下标是否是「词边界起点」：仅用于纯 ASCII 词的整词判定。 */
  boundary: boolean[];
}

/**
 * 归一化：繁简（复用项目的 ChineseConverter，与 normalizeComparableText 同源）、全半角（NFKC）、小写；
 * 这里再剥掉所有非字母数字字符（空白、标点、符号、零宽、控制、组合记号、emoji），
 * 并记录 ASCII 词的边界。连续的单字符 ASCII 片段（"s.e.x"）视为同一个词，防插空格规避。
 */
export function normalizeSensitiveText(value: string): NormalizedText {
  const base = toSimplified(value).normalize("NFKC").toLowerCase();
  // 令牌化：连续字母数字为一个令牌，其余字符是分隔。
  const chars: string[] = [];
  const boundary: boolean[] = [];
  let tokenStart = true;
  let previousClass = -1;
  let previousTokenSingleAscii = false;
  let tokenChars: string[] = [];

  const flush = (separated: boolean) => {
    if (tokenChars.length === 0) return;
    const singleAscii = tokenChars.length === 1 && isAsciiAlnum(tokenChars[0]!);
    // 与前一令牌合并的条件：两者都是单个 ASCII 字符。
    const merged = separated && singleAscii && previousTokenSingleAscii;
    for (const [index, char] of tokenChars.entries()) {
      chars.push(char);
      boundary.push(index === 0 && !merged);
    }
    previousTokenSingleAscii = singleAscii;
    tokenChars = [];
  };

  for (const char of base) {
    if (!isKept(char)) {
      flush(true);
      tokenStart = true;
      previousClass = -1;
      continue;
    }
    const cls = isAsciiAlnum(char) ? ASCII_ALNUM : CJK_OR_OTHER;
    // 汉字与 ASCII 之间切换也算令牌边界。
    if (!tokenStart && cls !== previousClass) {
      flush(false);
      previousTokenSingleAscii = false;
    }
    tokenChars.push(char);
    tokenStart = false;
    previousClass = cls;
  }
  flush(true);
  return { chars, boundary };
}

interface Node {
  next: Map<string, number>;
  fail: number;
  /** 以此节点结尾的词条下标（含沿失败链继承）。 */
  out: number[];
}

interface Entry {
  /** 归一化后的词面，仅供词表维护工具统计误伤，运行时检测不使用。 */
  text: string;
  length: number;
  /** 纯 ASCII 词需要整词边界。 */
  ascii: boolean;
}

class Automaton {
  private readonly nodes: Node[] = [{ next: new Map(), fail: 0, out: [] }];
  private readonly entries: Entry[] = [];

  constructor(
    words: Iterable<string>,
    readonly asciiBoundary: boolean
  ) {
    for (const word of words) {
      const chars = [...normalizeSensitiveText(word).chars];
      if (chars.length === 0) continue;
      let node = 0;
      for (const char of chars) {
        let nextIndex = this.nodes[node]!.next.get(char);
        if (nextIndex === undefined) {
          nextIndex = this.nodes.length;
          this.nodes.push({ next: new Map(), fail: 0, out: [] });
          this.nodes[node]!.next.set(char, nextIndex);
        }
        node = nextIndex;
      }
      this.entries.push({
        text: chars.join(""),
        length: chars.length,
        ascii: chars.every(isAsciiAlnum),
      });
      this.nodes[node]!.out.push(this.entries.length - 1);
    }
    const queue: number[] = [];
    for (const child of this.nodes[0]!.next.values()) queue.push(child);
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]!;
      for (const [char, child] of this.nodes[current]!.next) {
        let fail = this.nodes[current]!.fail;
        while (fail !== 0 && !this.nodes[fail]!.next.has(char)) fail = this.nodes[fail]!.fail;
        const target = this.nodes[fail]!.next.get(char);
        this.nodes[child]!.fail = target !== undefined && target !== child ? target : 0;
        this.nodes[child]!.out.push(...this.nodes[this.nodes[child]!.fail]!.out);
        queue.push(child);
      }
    }
  }

  textOf(start: number, end: number, text: NormalizedText): string {
    return text.chars.slice(start, end).join("");
  }

  get size(): number {
    return this.entries.length;
  }

  /** 遍历所有命中区间 [start, end)；回调返回 true 表示提前结束。 */
  scan(text: NormalizedText, visit: (start: number, end: number) => boolean): void {
    let node = 0;
    const { chars, boundary } = text;
    for (let index = 0; index < chars.length; index++) {
      const char = chars[index]!;
      while (node !== 0 && !this.nodes[node]!.next.has(char)) node = this.nodes[node]!.fail;
      node = this.nodes[node]!.next.get(char) ?? 0;
      for (const entryIndex of this.nodes[node]!.out) {
        const entry = this.entries[entryIndex]!;
        const start = index + 1 - entry.length;
        const end = index + 1;
        if (this.asciiBoundary && entry.ascii) {
          const startOk = boundary[start] === true;
          const endOk = end === chars.length || boundary[end] === true;
          if (!startOk || !endOk) continue;
        }
        if (visit(start, end)) return;
      }
    }
  }
}

export interface SensitiveTextOptions {
  /** 单字词与过短 ASCII 词容易误伤，不启用。 */
  minAsciiLength?: number;
  /** 在通用语境里误伤过多、整词停用的词条。 */
  disabledWords?: readonly string[];
}

export class SensitiveTextFilter {
  private readonly lexicon: Automaton;
  private readonly whitelist: Automaton;

  constructor(
    words: readonly string[],
    whitelist: readonly string[] = [],
    options: SensitiveTextOptions = {}
  ) {
    const minAscii = options.minAsciiLength ?? 3;
    const disabled = new Set(
      (options.disabledWords ?? []).map((word) => normalizeSensitiveText(word).chars.join(""))
    );
    const usable = words.filter((word) => {
      if (disabled.has(normalizeSensitiveText(word).chars.join(""))) return false;
      const chars = [...normalizeSensitiveText(word).chars];
      if (chars.length < 2) return false;
      if (chars.every(isAsciiAlnum)) {
        // 纯数字与过短的字母词误伤太多。
        return chars.length >= minAscii && !chars.every((char) => /\d/.test(char));
      }
      return true;
    });
    this.lexicon = new Automaton(usable, true);
    this.whitelist = new Automaton(whitelist, false);
  }

  get wordCount(): number {
    return this.lexicon.size;
  }

  /** 词表维护工具用：列出文本命中的归一化词面（不考虑白名单）。运行时检测不要用它回显。 */
  collectHits(value: string): string[] {
    const text = normalizeSensitiveText(value);
    const hits = new Set<string>();
    this.lexicon.scan(text, (start, end) => {
      hits.add(this.lexicon.textOf(start, end, text));
      return false;
    });
    return [...hits];
  }

  /** 是否包含不允许的词语。 */
  matches(value: string): boolean {
    if (!value) return false;
    const text = normalizeSensitiveText(value);
    if (text.chars.length < 2) return false;
    let spans: Array<[number, number]> | undefined;
    let hit = false;
    this.lexicon.scan(text, (start, end) => {
      if (!spans) {
        spans = [];
        this.whitelist.scan(text, (wStart, wEnd) => {
          spans!.push([wStart, wEnd]);
          return false;
        });
      }
      // 完全落在白名单词条内的命中不算；跨出白名单边界的照常算。
      if (spans.some(([wStart, wEnd]) => wStart <= start && end <= wEnd)) return false;
      hit = true;
      return true;
    });
    return hit;
  }
}

let activeFilter: SensitiveTextFilter | undefined;

const defaultFilter = (): SensitiveTextFilter => {
  activeFilter ??= new SensitiveTextFilter(lexiconData.words, whitelistData.phrases, {
    disabledWords: whitelistData.disabledWords,
  });
  return activeFilter;
};

/** 测试注入占位词表；传 undefined 恢复正式词表。 */
export const setSensitiveTextFilterForTest = (filter: SensitiveTextFilter | undefined): void => {
  activeFilter = filter;
};

export const containsSensitiveText = (value: string | null | undefined): boolean =>
  value ? defaultFilter().matches(value) : false;

/** 写入前断言：命中时抛业务错误，文案不含命中的词。 */
export function assertTextAllowed(...values: Array<string | null | undefined>): void {
  for (const value of values) {
    if (containsSensitiveText(value)) throw new AppError("TEXT_SENSITIVE", SENSITIVE_TEXT_MESSAGE);
  }
}

/** 启动时预热，避免首个请求承担构建耗时。 */
export const warmUpSensitiveText = (): number => defaultFilter().wordCount;
