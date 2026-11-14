import type {
  CreditLicenseBucket,
  CreditLicenseDocument,
  CreditLicenseLoaders,
} from "@/lib/Credits";
import { licenseBucket } from "@/lib/Credits";
import { createPromiseCache } from "@/lib/PromiseCache";
import licenseLoaders from "virtual:credits-licenses";

/**
 * 许可证原文的按需读取。
 *
 * 构建期把原文按包名首字符分桶（`virtual:credits-licenses-*`），这里只取当前包所在的那一桶：
 * 打开一个包的抽屉只下载一桶原文，不把整份法律文本塞进页面或首屏分块。
 * 同一个包重复打开时复用同一个 Promise；同一桶里的不同包也复用同一次桶加载。
 * 失败不落缓存：抽屉里的重试按钮要能再次发起同一桶的加载。同桶的包共用同一次失败，
 * 它们的逐包 Promise 也随之失败出缓存，重试才能重新请求。
 */
const buckets = createPromiseCache<string, CreditLicenseBucket>((bucket) => {
  const load = (licenseLoaders as CreditLicenseLoaders)[bucket];
  return load ? load() : Promise.resolve<CreditLicenseBucket>({});
});

const documents = createPromiseCache<string, CreditLicenseDocument | null>((packageName) =>
  buckets.get(licenseBucket(packageName)).then((bucket) => bucket[packageName] ?? null)
);

export function loadCreditsLicense(packageName: string): Promise<CreditLicenseDocument | null> {
  return documents.get(packageName);
}
