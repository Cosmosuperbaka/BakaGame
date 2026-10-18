import { afterEach } from "bun:test";
import { createApp, type AppDependencies } from "../src/transport/App";
import { SonGuessrService } from "../src/application/SonGuessrService";
import { CEEService } from "../src/application/CEEService";
import { AppError } from "../src/domain/Errors";

const releases: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) await release();
});

// HTTP、信封与来源校验测试保留真实游戏服务，仅隔离本用例不应访问的外部数据。
export function createTestApp(
  options: Omit<AppDependencies, "sonGuessrService" | "ceeService"> &
    Partial<Pick<AppDependencies, "sonGuessrService" | "ceeService">>
) {
  const unused = async (): Promise<never> => {
    throw new AppError("TEST_IO_FORBIDDEN", "本测试不允许访问游戏数据源");
  };
  const sonGuessrService =
    options.sonGuessrService ??
    new SonGuessrService({
      eventLogger: options.logger,
      musicProvider: {
        search: unused,
        getSong: unused,
        getSongMetadata: unused,
        getLoginStatus: unused,
      },
      bangumiProvider: {
        searchSubjects: unused,
        getSubject: unused,
        chooseRandomSubject: unused,
        resolveCharacterImage: unused,
        resolveSubjectImage: unused,
      },
    });
  const ceeService =
    options.ceeService ??
    new CEEService({
      data: {
        searchCharacters: unused,
        searchSubjects: unused,
        getSubjectCharacters: unused,
        getSubjects: unused,
        getRawCharacter: unused,
        getCharacter: unused,
        chooseRandomCharacter: unused,
        importDirectory: unused,
        resolveCharacterImage: unused,
        resolveSubjectImage: unused,
        close() {},
      },
    });
  releases.push(() => ceeService.close());
  return createApp({ ...options, sonGuessrService, ceeService });
}
