/** 规则引擎使用的 URL 小工具（纯函数）。 */

/** 小写 hostname；无法解析返回空串。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** pathname（未解码）；无法解析返回空串。 */
export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function pathExtension(url: string): string {
  try {
    const lastSegment = new URL(url).pathname.split("/").pop() || "";
    const dot = lastSegment.lastIndexOf(".");
    if (dot > 0 && dot < lastSegment.length - 1) {
      return lastSegment.substring(dot + 1).toLowerCase();
    }
  } catch {
    const m = url.match(/\.([a-zA-Z0-9]{1,10})(?:[?#]|$)/);
    if (m) return m[1].toLowerCase();
  }
  return "";
}

/**
 * 提取扩展名（小写、不带点）。
 *
 * 1. 取 pathname 末段扩展名（任意扩展名）。
 * 2. 仅当传入了 queryKeys 时继续：依次取这些参数的值，值须在 known 中；
 * 3. 再扫描所有 query 值，找以 `.ext` 结尾且 ext 在 known 中的值。
 *
 * 不传 queryKeys 时只看 path（与旧 extractExtension 一致）。
 */
export function extractExtension(
  url: string,
  queryKeys: readonly string[] = [],
  known?: ReadonlySet<string>,
): string {
  const fromPath = pathExtension(url);
  if (fromPath || queryKeys.length === 0) return fromPath;

  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return "";
  }
  const isKnown = (e: string): boolean => !known || known.has(e);

  for (const key of queryKeys) {
    const v = params.get(key);
    if (!v) continue;
    const e = v.toLowerCase().replace(/^\./, "");
    if (known?.has(e)) return e;
  }
  for (const v of params.values()) {
    const m = v.toLowerCase().match(/\.([a-z0-9]{1,10})$/);
    if (m && known && isKnown(m[1])) return m[1];
  }
  return "";
}
