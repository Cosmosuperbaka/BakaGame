import { Type as t, type Static } from "@sinclair/typebox";

const strict = { additionalProperties: false } as const;
/** 网易云热度门槛：0 表示不限，上限 1000000；客户端按刻度档位取值，服务端只校验范围。 */
export const MAX_MIN_POPULARITY = 1_000_000;
export const MinPopularitySchema = t.Integer({ minimum: 0, maximum: MAX_MIN_POPULARITY });
export const SongPlaylistFilterSchema = t.Object({
  id: t.String({ minLength: 1, maxLength: 64 }),
  name: t.Optional(t.String({ maxLength: 128 })),
  songCount: t.Optional(t.Integer({ minimum: 0 })),
}, strict);
export const SongArtistFilterSchema = t.Object({
  id: t.String({ minLength: 1, maxLength: 64 }),
  name: t.String({ minLength: 1, maxLength: 128 }),
}, strict);
/** 房间快照拥有规范化后的完整筛选条件。 */
export const SongAutoFiltersSchema = t.Object({
  playlist: t.Optional(SongPlaylistFilterSchema),
  artists: t.Array(SongArtistFilterSchema),
  minPopularity: MinPopularitySchema,
}, strict);
/** 入站设置可省略可规范化字段，不能把它声明成完整房间状态。 */
export const SongAutoFiltersInputSchema = t.Partial(SongAutoFiltersSchema, strict);
export type SongArtistFilter = Static<typeof SongArtistFilterSchema>;
export type SongPlaylistFilter = Static<typeof SongPlaylistFilterSchema>;
export type SongAutoFilters = Static<typeof SongAutoFiltersSchema>;
export type SongAutoFiltersInput = Static<typeof SongAutoFiltersInputSchema>;
