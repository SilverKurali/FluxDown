import type { ReleaseAsset } from "./release-format";

export function assetDownloadUrl(asset: ReleaseAsset, source: "auto" | "github" | "oss"): string {
  if (source === "github" && asset.github_download_url) return asset.github_download_url;
  // 官网主链接显式使用 auto：CF 缓存 → OSS 回源 → GitHub 兜底。
  // API 返回本站路径；保留 base、原始 tag 和其它参数，不重新推导组件版本。
  const url = new URL(asset.download_url, "https://download.invalid");
  url.searchParams.set("source", source);
  return `${url.pathname}${url.search}${url.hash}`;
}
