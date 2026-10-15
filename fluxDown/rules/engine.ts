/**
 * 规则求值器（纯模块）：把规则包 + 覆盖 + 吊销文档编译成一组查询函数。
 * 求值语义见计划 C3。
 */
import type { ConfidenceLevel } from "../utils/resource-types";
import builtinJson from "./builtin.json";
import {
  hostMatchesPattern,
  parseHostPattern,
  urlGlobMatch,
  type HostPattern,
} from "./glob";
import {
  RULE_ENGINE_VERSION,
  TIER_RANK,
  type EmitSpec,
  type MatchSpec,
  type ResourceType,
  type RevocationDoc,
  type RuleAction,
  type RuleOverrides,
  type RulePack,
  type SniffRuleV1,
} from "./schema";
import { extractExtension, hostOf, pathOf } from "./url";
import { PackRejectedError, validatePack } from "./validate";

export interface CompileInput {
  packs: RulePack[];
  overrides: RuleOverrides;
  revocations: RevocationDoc | null;
  options: { sniffImages: boolean; communityEnabled: boolean; now: number };
}

export interface RuleRef {
  id: string;
  version: number;
  tier: SniffRuleV1["tier"];
}

export interface ResponseInput {
  url: string;
  pageUrl: string;
  resourceType?: string;
  mime?: string;
  size: number;
  status?: number;
  headers?: Record<string, string>;
  attachment: boolean;
}

export type ResponseDecision =
  | {
      decision: "resource";
      type: ResourceType;
      confidence?: ConfidenceLevel;
      rule: RuleRef;
    }
  | { decision: "ignore"; rule: RuleRef }
  | { decision: "none" };

export interface Emitted {
  mode: "resource" | "preempt";
  url: string;
  filename?: string;
  type?: ResourceType;
  quality?: string;
}

export type RuleStatus =
  | "active"
  | "disabled"
  | "soft-revoked"
  | "hard-revoked"
  | "expired"
  | "engine-too-new";

export interface RuleListEntry {
  rule: SniffRuleV1;
  status: RuleStatus;
  reason?: string;
}

export interface BodyWatcher {
  rule: RuleRef;
  url?: string[];
  host?: string[];
  pathRegex?: string;
}

export interface BodyExtraction {
  rule: RuleRef;
  emits: Emitted[];
}

export interface DomRuleEntry {
  rule: RuleRef;
  selector: string;
  attr: string;
  emit: EmitSpec;
}

export interface CompiledRules {
  /** 受 requires / classifyOnly 约束 */
  classifyResponse(i: ResponseInput): ResponseDecision;
  /** 只看 resource 规则（忽略 requires、size）；MIME 优先，其次扩展名，都不中为 "other" */
  classify(url: string, mime?: string): ResourceType;
  isIgnored(url: string, pageUrl: string, attachment: boolean): RuleRef | null;
  /** 替代 normalizeUrlForDedup */
  dedupeKey(url: string, pageUrl: string): string;
  /** 先取 path 扩展名，再取 filename 规则 extFromQuery 中的已知扩展名 */
  fileExtension(url: string, pageUrl: string): string;
  trackKind(input: {
    url: string;
    filename?: string;
    mime?: string;
    pageUrl: string;
  }): "video" | "audio" | null;
  bodyWatchers(pageUrl: string): BodyWatcher[];
  extractFromBody(url: string, pageUrl: string, json: unknown): BodyExtraction[];
  domRules(pageUrl: string): DomRuleEntry[];
  renderDomEmit(
    rule: RuleRef,
    emit: EmitSpec,
    fields: { value: string; text: string },
  ): Emitted | null;
  listRules(): RuleListEntry[];
  /** 所有生效 resource 规则 match.ext 的并集（含 image），供 UI / 其它模块使用 */
  knownExtensions(): ReadonlySet<string>;
}

// ===== 匹配 =====

interface Ctx {
  url: string;
  host: string;
  pageHost: string;
  path: string;
  ext: string;
  mime: string;
  resourceType?: string;
  status?: number;
  size: number;
  attachment: boolean;
  headers: Record<string, string>;
}

type Pred = (c: Ctx) => boolean;

function makeCtx(
  url: string,
  pageUrl: string,
  extra: Partial<Pick<Ctx, "resourceType" | "status" | "size" | "attachment" | "headers">> & {
    mime?: string;
  } = {},
): Ctx {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra.headers ?? {})) headers[k.toLowerCase()] = v;
  return {
    url,
    host: hostOf(url),
    pageHost: hostOf(pageUrl),
    path: pathOf(url),
    ext: extractExtension(url),
    mime: (extra.mime ?? "").split(";")[0].trim().toLowerCase(),
    resourceType: extra.resourceType,
    status: extra.status,
    size: extra.size ?? 0,
    attachment: extra.attachment ?? false,
    headers,
  };
}

function compileHosts(list: string[]): HostPattern[] {
  const out: HostPattern[] = [];
  for (const p of list) {
    const parsed = parseHostPattern(p);
    if (parsed) out.push(parsed);
  }
  return out;
}

function compileMatch(m: MatchSpec): Pred {
  const preds: Pred[] = [];
  if (m.host) {
    const hs = compileHosts(m.host);
    preds.push((c) => c.host !== "" && hs.some((p) => hostMatchesPattern(c.host, p)));
  }
  if (m.pageHost) {
    const hs = compileHosts(m.pageHost);
    preds.push((c) => c.pageHost !== "" && hs.some((p) => hostMatchesPattern(c.pageHost, p)));
  }
  if (m.url) {
    const globs = m.url;
    preds.push((c) => globs.some((g) => urlGlobMatch(g, c.url)));
  }
  if (m.pathRegex !== undefined) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(m.pathRegex, "i");
    } catch {
      re = null;
    }
    preds.push((c) => re !== null && re.test(c.path));
  }
  if (m.ext) {
    const exts = new Set(m.ext.map((e) => e.toLowerCase()));
    preds.push((c) => c.ext !== "" && exts.has(c.ext));
  }
  if (m.hasExt !== undefined) {
    const want = m.hasExt;
    preds.push((c) => (c.ext !== "") === want);
  }
  if (m.mime) {
    const specs = m.mime.map((s) => s.toLowerCase());
    preds.push(
      (c) =>
        c.mime !== "" &&
        specs.some((s) => (s.endsWith("*") ? c.mime.startsWith(s.slice(0, -1)) : c.mime === s)),
    );
  }
  if (m.resourceType) {
    const types = m.resourceType;
    preds.push((c) => c.resourceType !== undefined && types.includes(c.resourceType));
  }
  if (m.status) {
    const [lo, hi] = m.status;
    preds.push((c) => c.status !== undefined && c.status >= lo && c.status <= hi);
  }
  if (m.minSize !== undefined) {
    const min = m.minSize;
    preds.push((c) => c.size <= 0 || c.size >= min);
  }
  if (m.maxSize !== undefined) {
    const max = m.maxSize;
    preds.push((c) => c.size <= 0 || c.size <= max);
  }
  if (m.attachment !== undefined) {
    const want = m.attachment;
    preds.push((c) => c.attachment === want);
  }
  if (m.header) {
    const hs: { name: string; re: RegExp | null }[] = m.header.map((h) => {
      let re: RegExp | null = null;
      try {
        re = new RegExp(h.regex, "i");
      } catch {
        re = null;
      }
      return { name: h.name.toLowerCase(), re };
    });
    preds.push((c) =>
      hs.every((h) => {
        const v = c.headers[h.name];
        return v !== undefined && h.re !== null && h.re.test(v);
      }),
    );
  }
  return (c) => preds.every((p) => p(c));
}

// ===== 模板 / 路径 =====

function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
    } else {
      if (!Object.hasOwn(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

type Fields = Record<string, string>;

/** `${x}` 替换；字段缺失返回 null。 */
function render(t: string, fields: Fields): string | null {
  let missing = false;
  const out = t.replace(/\$\{([^}]*)\}/g, (_m, key: string) => {
    if (!Object.hasOwn(fields, key)) {
      missing = true;
      return "";
    }
    return fields[key];
  });
  return missing ? null : out;
}

function resolveUrl(base: string, ref: string, bareQueryPrefix?: string): string | null {
  let out: string;
  if (ref.startsWith("http://") || ref.startsWith("https://")) {
    out = ref;
  } else if (ref.startsWith("/")) {
    try {
      out = new URL(base).origin + ref;
    } catch {
      return null;
    }
  } else if (bareQueryPrefix !== undefined) {
    out = base + bareQueryPrefix + ref;
  } else {
    return null;
  }
  return out.startsWith("http") ? out : null;
}

// ===== 编译 =====

interface CRule {
  ref: RuleRef;
  rule: SniffRuleV1;
  matches: Pred;
}

function isoMs(s: string | undefined): number {
  return s === undefined ? Number.NaN : Date.parse(s);
}

const GLOBAL_MATCH_KEYS: (keyof MatchSpec)[] = [
  "host", "pageHost", "url", "pathRegex", "ext", "hasExt", "mime",
  "resourceType", "status", "minSize", "maxSize", "attachment", "header",
];

function isGlobalMatch(r: SniffRuleV1): boolean {
  return (
    GLOBAL_MATCH_KEYS.every((k) => r.match[k] === undefined) &&
    (r.exclude ?? []).length === 0
  );
}

/** 编译规则集。 */
export function compileRules(input: CompileInput): CompiledRules {
  const { packs, overrides, revocations, options } = input;
  const now = options.now;
  const revokeValid = revocations !== null && isoMs(revocations.expiresAt) > now;

  const listing: RuleListEntry[] = [];
  const active: { rule: SniffRuleV1; order: number }[] = [];
  let order = 0;

  const revocationOf = (rule: SniffRuleV1): "soft" | "hard" | null => {
    let found: "soft" | "hard" | null = null;
    for (const e of revocations?.entries ?? []) {
      if (e.ruleId !== rule.id) continue;
      if (e.versions !== "*" && !(rule.version <= e.versions.max)) continue;
      if (e.action === "hard") return "hard";
      found = "soft";
    }
    return found;
  };

  for (const rawPack of packs) {
    if (rawPack.engine > RULE_ENGINE_VERSION) {
      for (const rule of Array.isArray(rawPack.rules) ? rawPack.rules : []) {
        listing.push({ rule, status: "engine-too-new", reason: "需要更新扩展" });
      }
      continue;
    }
    let pack: RulePack;
    try {
      pack = validatePack(rawPack, rawPack.packId).pack;
    } catch (e) {
      if (e instanceof PackRejectedError) continue;
      throw e;
    }

    let paused: { status: RuleStatus; reason: string } | null = null;
    if (pack.packId === "community") {
      if (!options.communityEnabled) {
        paused = { status: "disabled", reason: "社区规则已关闭" };
      } else if (pack.expiresAt !== undefined && !(isoMs(pack.expiresAt) > now)) {
        paused = { status: "expired", reason: "社区规则包已过期" };
      } else if (!revokeValid) {
        paused = { status: "expired", reason: "吊销列表缺失或已过期" };
      }
    }

    for (const rule of pack.rules) {
      const ov = overrides[rule.id];
      const rev = revocationOf(rule);
      if (rev === "hard") {
        listing.push({ rule, status: "hard-revoked", reason: "已被撤回" });
        continue;
      }
      if (paused) {
        listing.push({ rule, status: paused.status, reason: paused.reason });
        continue;
      }
      if (
        rev === "soft" &&
        !(ov?.enabled === true && ov.ackRevocation === revocations?.sequence)
      ) {
        listing.push({ rule, status: "soft-revoked", reason: "已被撤回（可手动确认启用）" });
        continue;
      }
      const enabled = ov ? ov.enabled : rule.enabled !== false;
      if (!enabled) {
        listing.push({ rule, status: "disabled" });
        continue;
      }
      listing.push({ rule, status: "active" });
      active.push({ rule, order: order++ });
    }
  }

  active.sort(
    (a, b) =>
      TIER_RANK[a.rule.tier] - TIER_RANK[b.rule.tier] ||
      (b.rule.priority ?? 0) - (a.rule.priority ?? 0) ||
      a.order - b.order,
  );

  const toC = (rule: SniffRuleV1): CRule => {
    const main = compileMatch(rule.match);
    const ex = (rule.exclude ?? []).map(compileMatch);
    return {
      ref: { id: rule.id, version: rule.version, tier: rule.tier },
      rule,
      matches: (c) => main(c) && !ex.some((p) => p(c)),
    };
  };

  const byKind = <K extends RuleAction["kind"]>(...kinds: K[]): CRule[] =>
    active
      .filter((a) => (kinds as string[]).includes(a.rule.action.kind))
      .map((a) => toC(a.rule));

  const responseRules = byKind("resource", "ignore");
  const stripRules = byKind("strip-params");
  const filenameRules = byKind("filename");
  const trackRules = byKind("track");
  const bodyRules = byKind("extract");
  const domRuleList = byKind("dom");

  const known = new Set<string>();
  for (const c of responseRules) {
    if (c.rule.action.kind !== "resource") continue;
    for (const e of c.rule.match.ext ?? []) known.add(e.toLowerCase());
  }

  const globalStrip = new Set<string>();
  const scopedStrip: CRule[] = [];
  for (const c of stripRules) {
    if (isGlobalMatch(c.rule)) {
      const a = c.rule.action;
      if (a.kind === "strip-params") for (const p of a.params) globalStrip.add(p.toLowerCase());
    } else {
      scopedStrip.push(c);
    }
  }

  const trackRegex = new Map<string, RegExp | null>();
  for (const c of trackRules) {
    const a = c.rule.action;
    if (a.kind !== "track") continue;
    try {
      trackRegex.set(c.rule.id, new RegExp(a.pattern, "i"));
    } catch {
      trackRegex.set(c.rule.id, null);
    }
  }

  const classify = (url: string, mime?: string): ResourceType => {
    const c = makeCtx(url, "", { mime });
    const resources = responseRules.filter((r) => r.rule.action.kind === "resource");
    const typeOf = (r: CRule): ResourceType =>
      (r.rule.action as Extract<RuleAction, { kind: "resource" }>).type;
    for (const r of resources) {
      if (r.rule.match.mime && r.matches(c)) return typeOf(r);
    }
    for (const r of resources) {
      if (!r.rule.match.mime && r.rule.match.ext && r.matches(c)) return typeOf(r);
    }
    return "other";
  };

  const emitOne = (spec: EmitSpec, fields: Fields): Emitted | null => {
    let url: string | null;
    if (typeof spec.url === "string") {
      url = render(spec.url, fields);
    } else {
      const base = render(spec.url.resolve.base, fields);
      const ref = render(spec.url.resolve.ref, fields);
      url = base === null || ref === null ? null : resolveUrl(base, ref, spec.url.resolve.bareQueryPrefix);
    }
    if (url === null) return null;
    const out: Emitted = { mode: spec.mode, url, type: spec.type ?? classify(url) };
    if (spec.filename !== undefined) {
      const f = render(spec.filename, fields);
      if (f !== null && f !== "") out.filename = f;
    }
    if (spec.quality !== undefined) {
      const q = render(spec.quality, fields);
      if (q !== null && q !== "") out.quality = q;
    }
    return out;
  };

  const scalarFields = (el: unknown, defs: Record<string, string>): Fields => {
    const out: Fields = {};
    for (const [name, path] of Object.entries(defs)) {
      const v = getPath(el, path);
      if (typeof v === "string") out[name] = v;
      else if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") out[name] = String(v);
    }
    return out;
  };

  const trackFromUrlHint = (url: string): "video" | "audio" | null => {
    let hint: string;
    try {
      hint = decodeURIComponent(url).toLowerCase();
    } catch {
      hint = url.toLowerCase();
    }
    if (hint.includes("audio/") || hint.includes("mime=audio")) return "audio";
    if (hint.includes("video/") || hint.includes("mime=video")) return "video";
    return null;
  };

  return {
    classifyResponse(i) {
      const c = makeCtx(i.url, i.pageUrl, {
        mime: i.mime,
        size: i.size,
        status: i.status,
        headers: i.headers,
        attachment: i.attachment,
        resourceType: i.resourceType,
      });
      for (const r of responseRules) {
        if (r.rule.classifyOnly) continue;
        if (r.rule.requires === "sniffImages" && !options.sniffImages) continue;
        if (!r.matches(c)) continue;
        const a = r.rule.action;
        if (a.kind === "ignore") return { decision: "ignore", rule: r.ref };
        if (a.kind === "resource") {
          return { decision: "resource", type: a.type, confidence: a.confidence, rule: r.ref };
        }
      }
      return { decision: "none" };
    },

    classify,

    isIgnored(url, pageUrl, attachment) {
      const c = makeCtx(url, pageUrl, { attachment });
      for (const r of responseRules) {
        if (r.rule.action.kind === "ignore" && r.matches(c)) return r.ref;
      }
      return null;
    },

    dedupeKey(url, pageUrl) {
      try {
        const u = new URL(url);
        u.hash = "";
        const strip = new Set(globalStrip);
        if (scopedStrip.length > 0) {
          const c = makeCtx(url, pageUrl);
          for (const r of scopedStrip) {
            const a = r.rule.action;
            if (a.kind === "strip-params" && r.matches(c)) {
              for (const p of a.params) strip.add(p.toLowerCase());
            }
          }
        }
        const del: string[] = [];
        u.searchParams.forEach((_v, k) => {
          if (strip.has(k.toLowerCase())) del.push(k);
        });
        for (const k of del) u.searchParams.delete(k);
        u.searchParams.sort();
        return u.toString();
      } catch {
        return url;
      }
    },

    fileExtension(url, pageUrl) {
      const fromPath = extractExtension(url);
      if (fromPath) return fromPath;
      const c = makeCtx(url, pageUrl);
      for (const r of filenameRules) {
        const a = r.rule.action;
        if (a.kind === "filename" && r.matches(c)) {
          return extractExtension(url, a.extFromQuery, known);
        }
      }
      return "";
    },

    trackKind(input) {
      const mime = (input.mime ?? "").toLowerCase();
      if (mime.startsWith("audio/")) return "audio";
      const c = makeCtx(input.url, input.pageUrl, { mime: input.mime });
      let hostHit = false;
      for (const r of trackRules) {
        const a = r.rule.action;
        if (a.kind !== "track" || !r.matches(c)) continue;
        hostHit = true;
        const m = (input.filename || input.url).match(trackRegex.get(r.rule.id) ?? /$^/);
        const g = trackRegex.get(r.rule.id) ? m?.[a.group] : undefined;
        if (g !== undefined) {
          if (a.audio.includes(g)) return "audio";
          if (!a.video || a.video.includes(g)) return "video";
        }
        if (a.fallback !== "none") return a.fallback;
      }
      if (mime.startsWith("video/") && !hostHit) return "video";
      return trackFromUrlHint(input.url);
    },

    bodyWatchers(pageUrl) {
      const c = makeCtx(pageUrl, pageUrl);
      const out: BodyWatcher[] = [];
      for (const r of bodyRules) {
        const m = r.rule.match;
        if (m.pageHost && !compileMatch({ pageHost: m.pageHost })(c)) continue;
        out.push({ rule: r.ref, url: m.url, host: m.host, pathRegex: m.pathRegex });
      }
      return out;
    },

    extractFromBody(url, pageUrl, json) {
      const c = makeCtx(url, pageUrl);
      const out: BodyExtraction[] = [];
      for (const r of bodyRules) {
        const a = r.rule.action;
        if (a.kind !== "extract" || !r.matches(c)) continue;
        if (a.when && !a.when.every((w) => getPath(json, w.path) === w.equals)) continue;
        let elements: unknown[];
        if (a.each !== undefined) {
          const arr = getPath(json, a.each);
          if (!Array.isArray(arr)) continue;
          elements = arr;
        } else {
          elements = [json];
        }
        const emits: Emitted[] = [];
        for (const el of elements) {
          const e = emitOne(a.emit, scalarFields(el, a.fields));
          if (e) emits.push(e);
        }
        if (emits.length > 0) out.push({ rule: r.ref, emits });
      }
      return out;
    },

    domRules(pageUrl) {
      const c = makeCtx(pageUrl, pageUrl);
      const out: DomRuleEntry[] = [];
      for (const r of domRuleList) {
        const a = r.rule.action;
        if (a.kind === "dom" && r.matches(c)) {
          out.push({ rule: r.ref, selector: a.selector, attr: a.attr, emit: a.emit });
        }
      }
      return out;
    },

    renderDomEmit(_rule, emit, fields) {
      return emitOne(emit, { value: fields.value, text: fields.text });
    },

    listRules() {
      return listing;
    },

    knownExtensions() {
      return known;
    },
  };
}

// ===== 内置包 =====

export const BUILTIN_PACK = builtinJson as unknown as RulePack;

/** 仅含 builtin 包的求值器（page hooks 使用）。 */
export function compileBuiltin(
  options: Partial<CompileInput["options"]> = {},
): CompiledRules {
  return compileRules({
    packs: [BUILTIN_PACK],
    overrides: {},
    revocations: null,
    options: {
      sniffImages: options.sniffImages ?? false,
      communityEnabled: options.communityEnabled ?? true,
      now: options.now ?? Date.now(),
    },
  });
}
