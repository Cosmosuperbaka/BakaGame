import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { renderEnvExample } from "../config/env/Registry";

/** 产物的落点只有这一处定义；`test/EnvRegistry.test.ts` 用它比对提交在库的清单。 */
export const ENV_EXAMPLE_PATH = resolve(import.meta.dir, "../../.env.example");

if (import.meta.main) {
  await writeFile(ENV_EXAMPLE_PATH, renderEnvExample(), "utf8");
}
