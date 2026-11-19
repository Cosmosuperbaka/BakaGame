export const amllTtmlFixture = (text = "恢复后的歌词正文") =>
  `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0:01.000" end="0:04.000"><span begin="0:01.000" end="0:04.000">${text}</span></p></div></body></tt>`;
export const amllResponse = () =>
  Response.json({ status: 200, data: { lyrics: amllTtmlFixture() } });

/** 让 provider 永不真的打 AMLL 公网：注入总是返回空的取词实现。 */
export const offlineAmll = {
  fetchAmllLyrics: async () => undefined,
  fetchAmllSearchLyrics: async () => undefined,
} as const;

export const LRC = "[00:01.00]第一句\n[00:03.50]第二句";
