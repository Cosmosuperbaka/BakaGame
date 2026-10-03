import { Type as t, type Static } from "@sinclair/typebox";

const strict = { additionalProperties: false } as const;
export const MinPopularitySchema = t.Union([t.Literal(0), t.Literal(1_000), t.Literal(10_000), t.Literal(100_000)]);
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
