/** 歌词比较用的文本归一：忽略大小写、全半角、空白与常见标点。 */
export const normalizeLyricComparable = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-_—–/:：·.'"“”‘’()（）[\]【】]/g, "");
