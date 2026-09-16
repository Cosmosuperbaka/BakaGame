/**
 * 出题数 / 猜测数上报到原版 CCB 服务器。
 *
 * 兼容版房间本来就要配置原版服务器地址（`CCB_ORIGINAL_SERVER_URL`），顺手把
 * 「这个角色被出题几次 / 被猜几次」也报给原版：增强版玩家的对局因此同样进入
 * 原版的角色使用率统计（原版 `/api/character-usage/:id` 与排行榜读的就是这两张表）。
 *
 * 两个端点共用同一份契约：
 * ```
 * POST /api/answer-character-count   body { characterId: number, characterName: string }
 * POST /api/guess-character-count    body { characterId: number, characterName: string }
 * ```
 *
 * 统计是**旁路**：任何失败只记日志、绝不抛出，也不参与房间状态与结算。
 */
export type CCBStatsKind = "answer" | "guess";

const ENDPOINT: Record<CCBStatsKind, string> = {
  answer: "/api/answer-character-count",
  guess: "/api/guess-character-count",
};

export interface CCBOriginalReporterOptions {
  /** 原版 CCB 服务器地址（由环境变量注入）。为空即整体停用。 */
  serverUrl: string;
  logger?: { error: (message: string, context?: Record<string, unknown>) => void };
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export class CCBOriginalReporter {
  private readonly serverUrl: string;
  private readonly logger?: CCBOriginalReporterOptions["logger"];
  private readonly fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  constructor(options: CCBOriginalReporterOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, "");
    this.logger = options.logger;
    this.fetcher = options.fetcher ?? fetch;
  }

  /**
   * 上报一次角色使用。未配置服务器地址、或 character 非法时静默跳过——
   * 调用方可以直接 `void reporter.report(...)`，不需要额外判空。
   */
  async report(kind: CCBStatsKind, character: { id: number; name: string }): Promise<void> {
    if (!this.serverUrl) return;
    if (!Number.isInteger(character.id) || character.id <= 0 || !character.name) return;
    try {
      const response = await this.fetcher(`${this.serverUrl}${ENDPOINT[kind]}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: character.id, characterName: character.name }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      // 原版服务器不可达绝不能影响对局；原版自己也只把这些计数当统计用。
      this.logger?.error("上报原版角色统计失败", {
        kind,
        characterId: character.id,
        reason: String(error),
      });
    }
  }
}
