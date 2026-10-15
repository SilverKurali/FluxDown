/** 规则包校验：整包不合格抛 PackRejectedError，单条不合格则剔除。 */
import { parseHostPattern } from "./glob";
import {
  RULE_ENGINE_VERSION,
  STAGE_ACTIONS,
  TIER_RANK,
  type EmitSpec,
  type MatchSpec,
  type RulePack,
  type RuleTier,
  type SniffRuleV1,
} from "./schema";

const MAX_RULES_PER_PACK = 2000;
const MAX_REGEX_LEN = 256;
const MAX_SELECTOR_LEN = 512;
const ID_RE = /^(builtin|official|community|local)\.[a-z0-9][a-z0-9._-]{1,62}$/;
const RESOURCE_TYPES = new Set([
  "video",
  "audio",
  "document",
  "archive",
  "image",
  "executable",
  "torrent",
  "stream",
  "subtitle",
  "magnet",
  "other",
]);
const NESTED_QUANTIFIER_RE = /\((?:[^()\\]|\\.)*[*+](?:[^()\\]|\\.)*\)[*+{]/;

/** 整包不合格。 */
export class PackRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackRejectedError";
  }
}

/** 正则安全子集：长度、可编译、无反向引用 / 环视 / 嵌套量词。 */
export function isSafeRegex(pattern: string): boolean {
  if (typeof pattern !== "string" || pattern.length > MAX_REGEX_LEN) return false;
  try {
    new RegExp(pattern, "i");
  } catch {
    return false;
  }
  if (/\\[1-9]|\\k</.test(pattern)) return false;
  if (/\(\?(?:=|!|<=|<!)/.test(pattern)) return false;
  if (NESTED_QUANTIFIER_RE.test(pattern)) return false;
  return true;
}

function checkMatch(m: MatchSpec | undefined): string | null {
  if (m === undefined) return null;
  if (typeof m !== "object" || m === null) return "match 不是对象";
  for (const list of [m.host, m.pageHost]) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) return "host/pageHost 须为数组";
    for (const h of list) {
      if (typeof h !== "string" || parseHostPattern(h) === null)
        return `非法 host 模式: ${String(h)}`;
    }
  }
  if (m.pathRegex !== undefined && !isSafeRegex(m.pathRegex))
    return "pathRegex 不安全";
  for (const h of m.header ?? []) {
    if (!h || typeof h.name !== "string" || !isSafeRegex(h.regex))
      return "header 正则不安全";
  }
  return null;
}

const TEMPLATE_REF_RE = /\$\{([^}]*)\}/g;

function templateRefs(t: string | undefined): string[] {
  if (typeof t !== "string") return [];
  return [...t.matchAll(TEMPLATE_REF_RE)].map((m) => m[1]);
}

function emitRefs(emit: EmitSpec): string[] {
  const url = emit.url;
  const urlRefs =
    typeof url === "string"
      ? templateRefs(url)
      : [
          ...templateRefs(url?.resolve?.base),
          ...templateRefs(url?.resolve?.ref),
        ];
  return [...urlRefs, ...templateRefs(emit.filename), ...templateRefs(emit.quality)];
}

function checkEmit(emit: EmitSpec, allowed: Set<string>, tier: RuleTier): string | null {
  if (!emit || typeof emit !== "object") return "emit 缺失";
  if (emit.mode !== "resource" && emit.mode !== "preempt") return "emit.mode 非法";
  if (emit.mode === "preempt" && tier !== "builtin" && tier !== "official")
    return "preempt 仅允许 builtin / official";
  if (emit.type !== undefined && !RESOURCE_TYPES.has(emit.type))
    return "emit.type 非法";
  if (
    typeof emit.url !== "string" &&
    !(emit.url && typeof emit.url === "object" && emit.url.resolve)
  )
    return "emit.url 缺失";
  for (const ref of emitRefs(emit)) {
    if (!allowed.has(ref)) return `模板引用了未定义字段: ${ref}`;
  }
  return null;
}

function checkSelector(selector: string): string | null {
  if (typeof selector !== "string" || selector.length === 0) return "selector 缺失";
  if (selector.length > MAX_SELECTOR_LEN) return "selector 过长";
  if (typeof document !== "undefined") {
    try {
      document.createDocumentFragment().querySelector(selector);
    } catch {
      return "selector 非法";
    }
  }
  return null;
}

function hasHost(m: MatchSpec): boolean {
  return (
    (Array.isArray(m.host) && m.host.length > 0) ||
    (Array.isArray(m.pageHost) && m.pageHost.length > 0)
  );
}

/** 校验单条规则；合格返回 null，否则返回原因。 */
function checkRule(rule: SniffRuleV1, expectedTier: RuleTier): string | null {
  if (!rule || typeof rule !== "object") return "规则不是对象";
  if (typeof rule.id !== "string" || !ID_RE.test(rule.id)) return "id 非法";
  if (rule.tier !== expectedTier) return "tier 与 packId 不符";
  if (!rule.id.startsWith(`${rule.tier}.`)) return "id 前缀与 tier 不符";
  if (!Number.isInteger(rule.version) || rule.version < 1) return "version 非法";
  if (!rule.match || typeof rule.match !== "object") return "match 缺失";
  if (!rule.action || typeof rule.action !== "object") return "action 缺失";
  const allowedKinds = STAGE_ACTIONS[rule.stage];
  if (!allowedKinds) return "stage 非法";
  if (!allowedKinds.includes(rule.action.kind)) return "stage 与 action 不匹配";
  if (rule.requires !== undefined && rule.requires !== "sniffImages")
    return "requires 非法";

  const matchErr = checkMatch(rule.match);
  if (matchErr) return matchErr;
  if (rule.exclude !== undefined && !Array.isArray(rule.exclude))
    return "exclude 须为数组";
  for (const ex of rule.exclude ?? []) {
    const e = checkMatch(ex);
    if (e) return `exclude: ${e}`;
  }

  if (rule.tier === "community" && !hasHost(rule.match))
    return "社区规则必须限定 host 或 pageHost";

  const a = rule.action;
  switch (a.kind) {
    case "resource":
      if (!RESOURCE_TYPES.has(a.type)) return "resource.type 非法";
      break;
    case "ignore":
      break;
    case "strip-params":
      if (!Array.isArray(a.params)) return "params 须为数组";
      if (
        !hasHost(rule.match) &&
        rule.tier !== "builtin" &&
        rule.tier !== "official" &&
        rule.tier !== "local"
      )
        return "全局 strip-params 仅允许 builtin / official / local";
      break;
    case "filename":
      if (!Array.isArray(a.extFromQuery)) return "extFromQuery 须为数组";
      break;
    case "track":
      if (!isSafeRegex(a.pattern)) return "track.pattern 不安全";
      if (!Number.isInteger(a.group) || a.group < 0) return "track.group 非法";
      if (!Array.isArray(a.audio)) return "track.audio 须为数组";
      break;
    case "extract": {
      if (!a.fields || typeof a.fields !== "object") return "fields 缺失";
      const err = checkEmit(a.emit, new Set(Object.keys(a.fields)), rule.tier);
      if (err) return err;
      break;
    }
    case "dom": {
      const sel = checkSelector(a.selector);
      if (sel) return sel;
      if (typeof a.attr !== "string") return "attr 缺失";
      const err = checkEmit(a.emit, new Set(["value", "text"]), rule.tier);
      if (err) return err;
      break;
    }
  }
  return null;
}

/**
 * 校验规则包。单条不合格剔除（记入 rejected），整包不合格抛 PackRejectedError。
 */
export function validatePack(
  pack: RulePack,
  expectedTier: RuleTier,
): { pack: RulePack; rejected: { id: string; reason: string }[] } {
  if (!pack || typeof pack !== "object") throw new PackRejectedError("不是对象");
  if (pack.format !== "fluxdown-sniff-pack") throw new PackRejectedError("format 错误");
  if (!(expectedTier in TIER_RANK)) throw new PackRejectedError("expectedTier 非法");
  if (pack.packId !== expectedTier) throw new PackRejectedError("packId 与预期层级不符");
  if (!Number.isInteger(pack.engine) || pack.engine > RULE_ENGINE_VERSION)
    throw new PackRejectedError("engine 版本过新或非法");
  if (!Number.isInteger(pack.sequence) || pack.sequence < 0)
    throw new PackRejectedError("sequence 非法");
  if (!Array.isArray(pack.rules) || pack.rules.length > MAX_RULES_PER_PACK)
    throw new PackRejectedError("rules 非法或超过上限");

  const seen = new Set<string>();
  const accepted: SniffRuleV1[] = [];
  const rejected: { id: string; reason: string }[] = [];
  for (const rule of pack.rules) {
    const id = typeof rule?.id === "string" ? rule.id : "";
    if (id && seen.has(id)) {
      rejected.push({ id, reason: "id 重复" });
      continue;
    }
    const reason = checkRule(rule, expectedTier);
    if (reason) {
      rejected.push({ id, reason });
      continue;
    }
    seen.add(id);
    accepted.push(rule);
  }
  return { pack: { ...pack, rules: accepted }, rejected };
}
