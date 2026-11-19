/**
 * SQLite FTS5 的 MATCH 右值是**查询语法**而不是字面量：`:` 是列过滤、`-` 是排除、
 * `(` `)` 是分组、`AND/OR/NOT/NEAR` 是运算符、`*` 是前缀。玩家输入的合法标题
 * （`Re:Zero`、`K-ON!`）直接拼进去会抛语法错误，所以必须整体包成短语并转义双引号。
 */
export const ftsPhrase = (query: string): string => `"${query.replace(/"/g, '""')}"`;

/** LIKE 的通配符（`%` `_`）与转义符本身要按字面匹配；配合 `ESCAPE '\'` 使用。 */
export const escapeLike = (keyword: string): string => keyword.replace(/[\\%_]/g, "\\$&");
