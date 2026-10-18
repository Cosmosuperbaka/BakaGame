import type {
  CreditLicenseBucket,
  CreditLicenseDocument,
  CreditLicenseLoaders,
} from "@/lib/Credits";
import { licenseBucket } from "@/lib/Credits";
import licenseLoaders from "virtual:credits-licenses";

/**
 * 许可证原文的按需读取。
 *
 * 构建期把原文按包名首字符分桶（`virtual:credits-licenses-*`），这里只取当前包所在的那一桶：
 * 打开一个包的抽屉只下载一桶原文，不把整份法律文本塞进页面或首屏分块。
 * 同一个包重复打开时复用同一个 Promise；同一桶里的不同包也复用同一次桶加载。
 * 失败不落缓存：抽屉里的重试按钮要能再次发起同一桶的加载。
 */
const pendingBuckets = new Map<string, Promise<CreditLicenseBucket>>();
const pendingDocuments = new Map<string, Promise<CreditLicenseDocument | null>>();

function loadBucket(packageName: string): Promise<CreditLicenseBucket> {
  const bucket = licenseBucket(packageName);
  const cached = pendingBuckets.get(bucket);
  if (cached) return cached;

  const loaders = licenseLoaders as CreditLicenseLoaders;
  const load = loaders[bucket];
  const request = load ? load() : Promise.resolve<CreditLicenseBucket>({});
  pendingBuckets.set(bucket, request);
  request.catch(() => {
    pendingBuckets.delete(bucket);
    // 同桶的包共用同一次失败，逐包缓存也一并清掉，重试才能重新请求。
    for (const name of pendingDocuments.keys()) {
      if (licenseBucket(name) === bucket) pendingDocuments.delete(name);
    }
  });
  return request;
}

export function loadCreditsLicense(packageName: string): Promise<CreditLicenseDocument | null> {
  const cached = pendingDocuments.get(packageName);
  if (cached) return cached;

  const request: Promise<CreditLicenseDocument | null> = loadBucket(packageName).then(
    (bucket) => bucket[packageName] ?? null
  );
  pendingDocuments.set(packageName, request);
  request.catch(() => pendingDocuments.delete(packageName));
  return request;
}
