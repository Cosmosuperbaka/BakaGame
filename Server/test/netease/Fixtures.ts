export const amllTtmlFixture = (text = "恢复后的歌词正文") =>
  `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0:01.000" end="0:04.000"><span begin="0:01.000" end="0:04.000">${text}</span></p></div></body></tt>`;
export const amllResponse = () =>
  Response.json({ status: 200, data: { lyrics: amllTtmlFixture() } });
