import { expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { CEESettingsSchema } from "../src/shared/CEE";
import { createDefaultCEESettings } from "../src/shared/CEEDefaults";
import {
  CEE_SETTING_BOUNDS,
  SONG_SUBJECT_LIMIT_BOUNDS,
  SUBJECT_YEAR_BOUNDS,
} from "../src/shared/SettingBounds";
import { SonGuessrPayloadSchemas } from "../src/shared/SonGuessr";

const ceeAccepts = (patch: Record<string, unknown>): boolean =>
  Value.Check(CEESettingsSchema, { ...createDefaultCEESettings(2020), ...patch });

const songFiltersAccept = (patch: Record<string, unknown>): boolean =>
  Value.Check(SonGuessrPayloadSchemas["song.room.updateSettings"], { animeAutoFilters: patch });

/** 每一项钉住最小值、最大值与两侧越界各一个：范围放宽或收紧都必须显式改这条用例。 */
const CASES: Array<{
  name: string;
  min: number;
  max: number;
  accepts: (value: number) => boolean;
}> = [
  { name: "CEE 热度前几部", min: 1, max: 1000, accepts: (v) => ceeAccepts({ topNSubjects: v }) },
  { name: "CEE 每部候选角色数", min: 1, max: 100, accepts: (v) => ceeAccepts({ characterNum: v }) },
  { name: "CEE 起始年份", min: 1900, max: 2200, accepts: (v) => ceeAccepts({ startYear: v }) },
  { name: "CEE 结束年份", min: 1900, max: 2200, accepts: (v) => ceeAccepts({ endYear: v }) },
  {
    name: "猜歌作品数量",
    min: 1,
    max: 1000,
    accepts: (v) => songFiltersAccept({ subjectLimit: v }),
  },
  {
    name: "猜歌起始年份",
    min: 1900,
    max: 2200,
    accepts: (v) => songFiltersAccept({ startYear: v }),
  },
  { name: "猜歌结束年份", min: 1900, max: 2200, accepts: (v) => songFiltersAccept({ endYear: v }) },
];

for (const { name, min, max, accepts } of CASES) {
  test(`${name} 的取值范围是 ${min}–${max}`, () => {
    expect(accepts(min)).toBe(true);
    expect(accepts(max)).toBe(true);
    expect(accepts(min - 1)).toBe(false);
    expect(accepts(max + 1)).toBe(false);
  });
}

const declared = (schema: { minimum?: number; maximum?: number }) => ({
  min: schema.minimum,
  max: schema.maximum,
});

test("schema 声明的界限与客户端取的常量逐项一致", () => {
  const cee = CEESettingsSchema.properties;
  expect(declared(cee.topNSubjects)).toEqual(CEE_SETTING_BOUNDS.topNSubjects);
  expect(declared(cee.characterNum)).toEqual(CEE_SETTING_BOUNDS.characterNum);
  expect(declared(cee.startYear)).toEqual(SUBJECT_YEAR_BOUNDS);
  expect(declared(cee.endYear)).toEqual(SUBJECT_YEAR_BOUNDS);

  const anime = SonGuessrPayloadSchemas["song.room.updateSettings"].properties.animeAutoFilters;
  expect(declared(anime.properties.subjectLimit)).toEqual(SONG_SUBJECT_LIMIT_BOUNDS);
  expect(declared(anime.properties.startYear)).toEqual(SUBJECT_YEAR_BOUNDS);
  expect(declared(anime.properties.endYear)).toEqual(SUBJECT_YEAR_BOUNDS);
});
