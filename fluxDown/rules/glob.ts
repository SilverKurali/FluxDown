/**
 * URL glob 与 host 匹配。
 *
 * urlGlobMatch 逐行移植自 native/engine/src/plugin/manifest.rs 的
 * url_glob_match / glob_segments，两端语义必须保持一致。
 */
import { normalizeDomain } from "../utils/domain-exclusion";

/** 仅 ASCII 大写转小写（对应 Rust to_ascii_lowercase）。 */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * `*` 是唯一通配符，按 `*` 分段顺序子串匹配（首段前缀锚定、尾段后缀锚定）。
 * pattern 与文本都先小写化。
 */
export function urlGlobMatch(pattern: string, url: string): boolean {
  return globSegments(asciiLower(pattern), asciiLower(url));
}

function globSegments(pattern: string, text: string): boolean {
  // 无通配符 = 精确匹配。
  if (!pattern.includes("*")) {
    return pattern === text;
  }
  const parts = pattern.split("*");
  const n = parts.length;
  let pos = 0;

  for (let i = 0; i < n; i++) {
    const part = parts[i];
    if (part === "") continue;
    if (i === 0) {
      // 首段前缀锚定。
      if (!text.slice(pos).startsWith(part)) return false;
      pos += part.length;
    } else if (i === n - 1) {
      // 尾段后缀锚定（在剩余串上）。
      if (!text.slice(pos).endsWith(part)) return false;
    } else {
      // 中段：从 pos 起找首个出现。
      const idx = text.slice(pos).indexOf(part);
      if (idx < 0) return false;
      pos += idx + part.length;
    }
  }
  return true;
}

/** 已解析的 host 模式。 */
export interface HostPattern {
  domain: string;
  /** true = 只匹配本域（"=example.com"） */
  exact: boolean;
}

/** 解析 host 模式；无效或使用 "*." 时返回 null。 */
export function parseHostPattern(pattern: string): HostPattern | null {
  const raw = pattern.trim();
  const exact = raw.startsWith("=");
  const body = exact ? raw.slice(1) : raw;
  if (body.trim().startsWith("*.")) return null;
  const domain = normalizeDomain(body);
  return domain ? { domain, exact } : null;
}

/** host 是否命中已解析的模式（DNS 标签边界）。 */
export function hostMatchesPattern(host: string, p: HostPattern): boolean {
  const h = host.toLowerCase();
  return p.exact ? h === p.domain : h === p.domain || h.endsWith(`.${p.domain}`);
}

/** 便捷版：解析并匹配。 */
export function hostMatches(host: string, pattern: string): boolean {
  const p = parseHostPattern(pattern);
  return p !== null && hostMatchesPattern(host, p);
}
