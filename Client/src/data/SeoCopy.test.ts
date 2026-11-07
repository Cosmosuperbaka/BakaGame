import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PAGE_META, SITE_ORIGIN, SITE_TAGLINE } from "@/data/PageMeta";

const PUBLIC_DIR = path.resolve(import.meta.dirname, "../../public");
const readPublic = (name: string) => readFileSync(path.join(PUBLIC_DIR, name), "utf8");

// 用户明确不要的宣传套话：写回来不会有任何报错，只能在这里拦。
const BANNED_PHRASES =
  /在线|线上|免下载|免注册|无需下载|无需注册|不用下载|点击即玩|打开就玩|即点即玩|即开即玩|一键开玩|打开就能玩|畅玩|海量|极致/;

/** 标语是用户刻意保留的句子，排除后再检查「最好玩」不会出现在别处。 */
const withoutTagline = (text: string) => text.split(SITE_TAGLINE).join("");

describe("SEO 文案", () => {
  const llms = readPublic("llms.txt");
  const pageCopy = JSON.stringify(PAGE_META);

  it("页面元信息与 llms.txt 都不含宣传套话", () => {
    expect(withoutTagline(pageCopy)).not.toMatch(BANNED_PHRASES);
    expect(withoutTagline(pageCopy)).not.toContain("最好玩");
    expect(withoutTagline(llms)).not.toMatch(BANNED_PHRASES);
    expect(withoutTagline(llms)).not.toContain("最好玩");
  });

  it("llms.txt 开头就是标语，首页正文也带标语", () => {
    expect(llms.split("\n").find((line) => line.startsWith(">"))).toContain(SITE_TAGLINE);
    expect(PAGE_META[0].shell.paragraphs[0].startsWith(SITE_TAGLINE)).toBe(true);
  });

  it("结构化数据的地址指向页面自身", () => {
    for (const meta of PAGE_META) {
      expect(meta.structuredData.url).toBe(`${SITE_ORIGIN}${meta.path}`);
    }
  });

  it("FAQ 答案第一句可以独立成立", () => {
    for (const meta of PAGE_META) {
      for (const { q, a } of meta.faq) {
        // 代词开头的句子被单独引用时读不懂。
        expect(a, `${meta.path}：${q}`).not.toMatch(/^(它|这|那|该|此|这个|这款)/);
        expect(a, `${meta.path}：${q}`).toMatch(/[。！？]/);
      }
    }
  });
});

describe("robots.txt", () => {
  /** 按空行分组，记录每组的 User-agent 与 Disallow。 */
  const groups = readPublic("robots.txt")
    .split(/\n\s*\n/)
    .map((block) => block.split("\n").map((line) => line.trim()))
    .reduce<{ agents: string[]; disallow: string[] }[]>((all, lines) => {
      const agents = lines
        .filter((l) => l.startsWith("User-agent:"))
        .map((l) => l.slice(11).trim());
      const disallow = lines.filter((l) => l.startsWith("Disallow:")).map((l) => l.slice(9).trim());
      if (agents.length > 0) all.push({ agents, disallow: [...disallow] });
      else if (all.length > 0) all[all.length - 1].disallow.push(...disallow);
      return all;
    }, []);

  it("主流 AI 爬虫被具名放行", () => {
    const named = groups.flatMap((group) => group.agents);
    for (const agent of [
      "GPTBot",
      "OAI-SearchBot",
      "ClaudeBot",
      "PerplexityBot",
      "Google-Extended",
    ]) {
      expect(named).toContain(agent);
    }
  });

  // 命名分组不继承 * 分组：少抄一条，AI 爬虫就能进后台与房间页。
  it("每个分组的屏蔽清单完全一致，且都挡住后台与房间页", () => {
    const [base, ...rest] = groups.map((group) => [...group.disallow].sort());
    expect(rest.length).toBeGreaterThan(0);
    for (const list of rest) expect(list).toEqual(base);
    expect(base).toEqual(
      expect.arrayContaining(["/admin", "/whoisfaker/room/", "/songuessr/room/", "/cee/room/"])
    );
  });
});
