import { AggregatedMusicProvider } from "../../src/infrastructure/music/AggregatedMusicProvider";
import { MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import { provider } from "../songuessr/Fixtures";

/** 双平台聚合音源：用例只覆盖各自关心的平台方法，其余沿用公共假音源。 */
export const createAggregatedProvider = ({
  netease = {},
  qq = {},
}: {
  netease?: Partial<MusicProvider>;
  qq?: Partial<MusicProvider>;
} = {}): AggregatedMusicProvider =>
  new AggregatedMusicProvider({
    neteaseProvider: { ...provider, ...netease },
    qqProvider: { ...provider, ...qq },
  });
