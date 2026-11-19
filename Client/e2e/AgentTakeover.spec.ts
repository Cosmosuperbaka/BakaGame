import { errors, type Page } from "@playwright/test";
import { expect, test } from "./fixtures/Isolation";

/**
 * 标签页接管的整条链路：模拟 Agent 走真实的远程 MCP 端点，人类页面走真实浏览器。
 *
 * 人类的操作用 `page.mouse` / `page.keyboard` 发真实输入（`isTrusted`），
 * 否则断言不到「人类被挡下、Agent 照常通过」这条分界。
 */
const MCP_URL = "http://127.0.0.1:4850/api/mcp";

interface PageControl {
  id: string;
  role: string;
  label: string;
  value?: string;
  states?: string[];
  inView: boolean;
}

interface PageView {
  path: string;
  title: string;
  restricted?: boolean;
  lines: string[];
  offscreenLines: string[];
  controls: PageControl[];
}

class MockAgent {
  private session: string | undefined;
  private seq = 0;

  constructor(private readonly name: string) {}

  async call<T = Record<string, unknown>>(
    tool: string,
    args: Record<string, unknown> = {}
  ): Promise<T> {
    const response = await fetch(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: (this.seq += 1),
        method: "tools/call",
        params: {
          name: tool,
          arguments: {
            ...args,
            agentName: this.name,
            ...(this.session ? { session: this.session } : {}),
          },
        },
      }),
    });
    const body = (await response.json()) as {
      result?: { isError?: boolean; content: Array<{ text: string }> };
      error?: { message: string };
    };
    if (!body.result) throw new Error(body.error?.message ?? "MCP 无响应");
    const text = body.result.content[0]?.text ?? "";
    if (body.result.isError) throw new Error(text);
    const parsed = JSON.parse(text) as { session?: string };
    this.session = parsed.session ?? this.session;
    return parsed as T;
  }

  async end(): Promise<void> {
    await fetch(MCP_URL, {
      method: "DELETE",
      headers: { "mcp-session-id": this.session ?? "" },
    });
  }
}

const view = (agent: MockAgent) => agent.call<{ view: PageView }>("page_state");

const act = (agent: MockAgent, steps: Array<Record<string, unknown>>) =>
  agent.call<{ ok: boolean; view: PageView }>("page_act", { steps });

const controlOf = (current: PageView, matcher: RegExp): PageControl | undefined =>
  current.controls.find((control) => matcher.test(control.label) || matcher.test(control.id));

const requireControl = (current: PageView, matcher: RegExp): PageControl => {
  const control = controlOf(current, matcher);
  if (!control) throw new Error(`没有控件 ${matcher}：${JSON.stringify(current.controls)}`);
  return control;
};

/** 人类开启接管并拿到配对码。 */
const pair = async (page: Page, agent: MockAgent): Promise<PageView> => {
  await page.getByRole("button", { name: "设置" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("switch", { name: "交给 Agent 操作" }).click();
  const code = await dialog.getByText(/^[A-Z2-9]{8}$/).textContent();
  const claimed = await agent.call<{ view: PageView }>("control_page", { code });
  await expect(page.getByRole("button", { name: "收回控制" })).toBeVisible();
  await expect(dialog).toBeHidden();
  return claimed.view;
};

const release = (page: Page) => page.getByRole("button", { name: "收回控制" });

const createRoomAsAgent = async (agent: MockAgent, page: Page, name: string) => {
  const dialog = (await act(agent, [{ action: "click", control: "lobby.create" }])).view;
  const created = await act(agent, [
    { action: "type", control: requireControl(dialog, /房间名称/).id, text: name },
    { action: "click", control: requireControl(dialog, /^创建$/).id },
  ]);
  await expect(page).toHaveURL(/\/whoisfaker\/room\/\d{4}$/);
  return created;
};

const WORD_STEPS = (input: string, submit: string, text: string) => [
  { action: "focus", control: input },
  { action: "type", text, replace: true },
  { action: "click", control: submit },
];

const SPEECH = "这是接管标签页的发言";

const control = (guest: Page, id: string) =>
  guest.locator(`[data-agent-control="${id}"]`).locator("visible=true").first();

/** 访客单步操作的等待上限：等不到就留给下一拍。 */
const GUEST_STEP_TIMEOUT_MS = 3_000;

/**
 * 访客这一拍尽力而为。游戏区按阶段键整块切换：别的玩家恰好在这时推进，刚填的输入框会随旧阶段一起退场，
 * 新阶段的提交钮是禁用的，死等只会等到整条用例超时。等不到可点就留给下一拍重新判断，
 * 外层循环有总拍数上限，真卡死会在那里暴露。
 */
const fillAndSubmit = async (guest: Page, fields: Array<[string, string]>, submit: string) => {
  try {
    for (const [id, text] of fields)
      await control(guest, id).fill(text, { timeout: GUEST_STEP_TIMEOUT_MS });
    await control(guest, submit).click({ timeout: GUEST_STEP_TIMEOUT_MS });
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error;
  }
};

/** 其余玩家是人类标签页：隔离环境里服务端连不到自己，Agent 自有座位进不来。 */
const guestTurn = async (
  guest: Page,
  index: number,
  beforeAdvance: () => Promise<void>
): Promise<void> => {
  if (await control(guest, "faker.description.input").isVisible()) {
    await fillAndSubmit(
      guest,
      [["faker.description.input", `线索${index}`]],
      "faker.description.send"
    );
    return;
  }
  if (await control(guest, "faker.word.civilian").isVisible()) {
    await fillAndSubmit(
      guest,
      [
        ["faker.word.civilian", "苹果"],
        ["faker.word.undercover", "香蕉"],
      ],
      "faker.words.submit"
    );
    return;
  }
  const advance = control(guest, "faker.advance");
  if ((await advance.isVisible()) && (await advance.isEnabled())) {
    await beforeAdvance();
    await advance.click();
    return;
  }
  const vote = guest
    .locator('[data-agent-control^="faker.vote."]:not([data-agent-control="faker.vote.abstain"])')
    .locator("visible=true")
    .first();
  if ((await vote.isVisible()) && (await vote.isEnabled())) await vote.click();
};

/** 被接管的标签页按页面上看到的控件行动，返回这一拍做了什么。 */
const tabTurn = async (agent: MockAgent): Promise<string | undefined> => {
  const current = (await view(agent)).view;
  const enabled = current.controls.filter((control) => !control.states?.includes("disabled"));
  const pick = (matcher: RegExp) => enabled.find((control) => matcher.test(control.id));
  const description = pick(/^faker\.description\.input$/);
  if (description) {
    await act(agent, WORD_STEPS(description.id, "faker.description.send", SPEECH)).catch(
      () => undefined
    );
    return "describe";
  }
  const civilian = pick(/^faker\.word\.civilian$/);
  if (civilian) {
    await act(agent, [
      { action: "type", control: civilian.id, text: "苹果" },
      { action: "type", control: "faker.word.undercover", text: "香蕉" },
      { action: "click", control: "faker.words.submit" },
    ]).catch(() => undefined);
    return "words";
  }
  const questioner = enabled.filter((item) => /^faker\.questioner\./.test(item.id)).at(-1);
  if (questioner) {
    await act(agent, [{ action: "click", control: questioner.id }]).catch(() => undefined);
    return "assign";
  }
  const vote = pick(/^faker\.vote\.(?!abstain)/);
  if (vote) {
    await act(agent, [{ action: "click", control: vote.id }]).catch(() => undefined);
    return "vote";
  }
  const other = pick(/^faker\.(night\.|advance)/);
  if (other) await act(agent, [{ action: "click", control: other.id }]).catch(() => undefined);
  return undefined;
};

const realClick = async (page: Page, x: number, y: number) => {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
};

test.describe("标签页接管", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("从首页到房间同一套：Agent 看、Agent 操作，人类被挡下但能随时收回", async ({
    page,
    isolatedContext,
  }) => {
    test.setTimeout(120_000);
    const agent = new MockAgent("测试Agent");
    await page.goto("/");

    const landing = await pair(page, agent);
    expect(landing.path).toBe("/");
    expect(JSON.stringify(landing)).not.toMatch(/[A-Z2-9]{8}/);
    expect(landing.controls.map((control) => control.label).join()).not.toContain("收回控制");

    // 人类的鼠标与键盘都落不到页面上。
    const entry = requireControl(landing, /site\.game\..*/);
    const card = page.locator(`[data-agent-control="${entry.id}"]`).first();
    const box = (await card.boundingBox())!;
    await realClick(page, box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/$/);

    // Agent 点同一个控件：焦点框先移到目标上，再跳转。
    const faker = requireControl(landing, /Who is Faker/);
    const entering = act(agent, [{ action: "click", control: faker.id }]);
    await expect(page.locator(".agent-focus-box")).toBeVisible();
    const focused = (await page.locator(".agent-focus-box").boundingBox())!;
    expect(focused.width).toBeGreaterThanOrEqual(box.width);
    const lobby = (await entering).view;
    await expect(page).toHaveURL(/\/whoisfaker$/);
    expect(lobby.path).toBe("/whoisfaker");

    // 大厅：逐字输入与建房都走页面控件。
    const name = requireControl(lobby, /用户名/);
    await act(agent, [{ action: "type", control: name.id, text: "接管玩家", replace: true }]);
    await expect(page.getByPlaceholder("用户名")).toHaveValue("接管玩家");
    const created = await createRoomAsAgent(agent, page, "接管测试房");
    expect(created.ok).toBe(true);
    const roomId = page.url().split("/").at(-1)!;

    // 房间内同一套：建房强制开着 MCP，其他玩家看得到徽标。
    const friendPage = await (await isolatedContext()).newPage();
    await friendPage.goto("/whoisfaker");
    await friendPage.getByPlaceholder("用户名").fill("朋友");
    await friendPage.getByRole("button", { name: /接管测试房/ }).click();
    await expect(friendPage).toHaveURL(new RegExp(`/room/${roomId}$`));
    await expect(friendPage.getByText("MCP", { exact: true }).first()).toBeVisible();

    await act(agent, [
      { action: "focus", control: "chat.input" },
      { action: "type", text: "大家好，我是 Agent" },
      { action: "click", control: "chat.send" },
    ]);
    await expect(friendPage.getByText("大家好，我是 Agent")).toBeVisible();

    // 刷新：不用重新配对，锁定与接管都续上，Agent 接着干活。
    await page.reload();
    await expect(release(page)).toBeVisible();
    await expect
      .poll(async () => {
        try {
          return (await view(agent)).view.path;
        } catch {
          return "";
        }
      })
      .toBe(`/whoisfaker/room/${roomId}`);
    await expect(page.locator(".agent-focus-box")).toBeVisible();
    await act(agent, [
      { action: "focus", control: "chat.input" },
      { action: "type", text: "刷新后继续" },
      { action: "click", control: "chat.send" },
    ]);
    await expect(friendPage.getByText("刷新后继续")).toBeVisible();

    // 人类随时收回：立刻解锁，Agent 下一步被拒。
    await release(page).click();
    await expect(release(page)).toBeHidden();
    await expect(page.getByText("已收回控制")).toBeVisible();
    await expect(view(agent)).rejects.toThrow(/PAGE_NOT_CONTROLLED/);
    await page.getByPlaceholder("请输入文本").fill("我回来了");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(friendPage.getByText("我回来了")).toBeVisible();
    await expect(friendPage.getByText("MCP", { exact: true })).toHaveCount(0);
    await friendPage.close();
  });

  test("敏感页面不开放，Agent 断开后页面立刻解锁并提示", async ({ page }) => {
    const agent = new MockAgent("测试Agent");
    await page.goto("/");
    await pair(page, agent);

    await expect(act(agent, [{ action: "navigate", path: "/admin" }])).rejects.toThrow(
      /PAGE_NOT_REACHABLE/
    );
    const account = controlOf((await view(agent)).view, /账号|登录/);
    expect(account).toBeUndefined();

    // 人类自己去了后台：Agent 什么也读不到。
    await page.goto("/admin");
    await expect(release(page)).toBeVisible();
    await expect
      .poll(async () => {
        try {
          return (await view(agent)).view.restricted;
        } catch {
          return undefined;
        }
      })
      .toBe(true);
    await page.goto("/");
    await expect(release(page)).toBeVisible();

    await agent.end();
    await expect(release(page)).toBeHidden();
    await expect(page.getByText(/已断开，页面已解锁/)).toBeVisible();
  });

  test("没开 MCP 的房间不能交给 Agent", async ({ page }) => {
    const agent = new MockAgent("测试Agent");
    await page.goto("/whoisfaker");
    await page.getByPlaceholder("用户名").fill("房主");
    await page.getByRole("button", { name: "创建房间" }).click();
    await page.getByPlaceholder("输入房间名称").fill("普通房");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page).toHaveURL(/\/whoisfaker\/room\/\d{4}$/);

    await page.getByRole("button", { name: "设置" }).first().click();
    const toggle = page.getByRole("dialog").getByRole("switch", { name: /交给 Agent 操作/ });
    await expect(toggle).toBeDisabled();
    await expect(page.getByRole("dialog")).toContainText("本房间未开启 MCP");
    await expect(agent.call("control_page", { code: "ABCD2345" })).rejects.toThrow(
      /PAGE_CODE_INVALID/
    );
  });
});

test.describe("完整对局", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Agent 经页面完成建房、开局、发言与投票，全程只走界面控件", async ({
    page,
    isolatedContext,
  }, testInfo) => {
    test.setTimeout(240_000);
    // 上一次尝试失败留下的房间还在服务端：重试时换一个不被旧房名包含的名字，免得一名对两房。
    const roomName = testInfo.retry === 0 ? "接管对局房" : `重试${testInfo.retry}的接管房`;
    const agent = new MockAgent("主控Agent");
    await page.goto("/whoisfaker");
    await page.getByPlaceholder("用户名").fill("接管房主");
    await pair(page, agent);
    await createRoomAsAgent(agent, page, roomName);

    const friendContext = await isolatedContext();
    const guests: Page[] = [];
    for (const name of ["甲", "乙", "丙", "丁"]) {
      const guest = await friendContext.newPage();
      await guest.goto("/whoisfaker");
      await guest.getByPlaceholder("用户名").fill(`玩家${name}`);
      await guest.getByRole("button", { name: new RegExp(roomName) }).click();
      await expect(guest).toHaveURL(/\/whoisfaker\/room\/\d{4}$/);
      await control(guest, "faker.ready").click();
      guests.push(guest);
    }

    await expect
      .poll(async () => {
        const current = (await view(agent)).view;
        const start = controlOf(current, /^faker\.start$/);
        return start !== undefined && !start.states?.includes("disabled");
      })
      .toBe(true);
    await act(agent, [{ action: "click", control: "faker.start" }]);

    const done = new Set<string>();
    let spoken = false;
    for (let tick = 0; tick < 40 && !(done.has("describe") && done.has("vote")); tick += 1) {
      const action = await tabTurn(agent);
      if (action) done.add(action);
      for (const [index, guest] of guests.entries())
        await guestTurn(guest, tick * 10 + index, async () => {
          // 发言要全员交齐才公开：主持人推进之前等一下，确认别的玩家真的收到了。
          // 推进按钮和发言列表不一定在同一帧渲染，不能只取样一次；进入投票后发言不再显示，等待要有上限。
          spoken ||= await guest
            .getByText(SPEECH)
            .first()
            .waitFor({ state: "visible", timeout: 2_000 })
            .then(
              () => true,
              () => false
            );
        });
    }
    expect([...done]).toEqual(expect.arrayContaining(["describe", "vote"]));
    expect(spoken).toBe(true);
    // 出题人写下了两个词，这张标签页只拿到自己的一个：Agent 同样看不到另一个。
    const seen = JSON.stringify((await view(agent)).view);
    expect(seen.includes("苹果") && seen.includes("香蕉")).toBe(false);
    await agent.end();
    await expect(release(page)).toBeHidden();
  });
});

test.describe("手机宽度", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("接管条、焦点框与收回入口都在视口内，屏幕外的目标滚入视野", async ({ page }) => {
    const agent = new MockAgent("手机Agent");
    await page.goto("/");
    const landing = await pair(page, agent);

    const bar = (await release(page).boundingBox())!;
    expect(bar.y + bar.height).toBeLessThanOrEqual(844);
    expect(bar.x + bar.width).toBeLessThanOrEqual(390);

    const offscreen = landing.controls.find(
      (control) => !control.inView && control.id.startsWith("site.")
    );
    if (offscreen) {
      await act(agent, [{ action: "scroll", control: offscreen.id }]);
      const moved = (await view(agent)).view.controls.find((item) => item.id === offscreen.id);
      expect(moved?.inView).toBe(true);
    }

    await page.touchscreen.tap(195, 300);
    await expect(page).toHaveURL(/\/$/);

    await act(agent, [{ action: "navigate", path: "/cee" }]);
    await expect(page).toHaveURL(/\/cee$/);
    await release(page).tap();
    await expect(release(page)).toBeHidden();
  });
});
