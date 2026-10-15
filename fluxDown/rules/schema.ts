/**
 * 嗅探规则 schema v1（纯类型 + 常量，零运行时依赖）。
 *
 * 规则包由「内置 / 官方 / 社区 / 本地」四个层级提供，求值器见 engine.ts。
 */
import type { ResourceType } from "../utils/resource-types";

export type { ResourceType };

export const RULE_ENGINE_VERSION = 1;

export type RuleTier = "builtin" | "official" | "community" | "local";

/** 层级优先级：数值越小越先求值（本地最先，内置最后）。 */
export const TIER_RANK: Record<RuleTier, number> = {
  local: 0,
  official: 1,
  community: 2,
  builtin: 3,
};

export type RuleStage = "response" | "normalize" | "track" | "body" | "dom";

export interface RulePack {
  format: "fluxdown-sniff-pack";
  /** 必须等于每条规则的 tier */
  packId: RuleTier;
  /** 非负整数，同 packId 单调递增 */
  sequence: number;
  /** > RULE_ENGINE_VERSION 时整包跳过 */
  engine: number;
  /** ISO 8601 */
  issuedAt: string;
  /** 仅 community 使用 */
  expiresAt?: string;
  rules: SniffRuleV1[];
}

export interface MatchSpec {
  /** "example.com" 匹配本域及子域；"=example.com" 只匹配本域；不支持 "*." */
  host?: string[];
  /** 同上，作用于顶层页面 host */
  pageHost?: string[];
  /** glob：语义与引擎 url_glob_match 一致（见 glob.ts） */
  url?: string[];
  /** 作用于 URL pathname；不区分大小写；受安全子集约束 */
  pathRegex?: string;
  /** 小写、不带点 */
  ext?: string[];
  /** URL 是否带可识别扩展名 */
  hasExt?: boolean;
  /** "video/*" 或精确值；去掉参数后小写比较 */
  mime?: string[];
  /** webRequest ResourceType；MAIN world 观察到的请求记作 "xmlhttprequest" */
  resourceType?: string[];
  /** 闭区间 */
  status?: [number, number];
  /** 字节；大小未知（-1/0）时视为满足 */
  minSize?: number;
  maxSize?: number;
  /** 响应头 Content-Disposition 是否为 attachment */
  attachment?: boolean;
  /** 响应头；name 小写 */
  header?: { name: string; regex: string }[];
}

export interface SniffRuleV1 {
  /** /^(builtin|official|community|local)\.[a-z0-9][a-z0-9._-]{1,62}$/，前缀等于 tier */
  id: string;
  /** 正整数 */
  version: number;
  tier: RuleTier;
  title?: string;
  /** 默认 true */
  enabled?: boolean;
  /** 默认 0，越大越先 */
  priority?: number;
  stage: RuleStage;
  /** 仅在对应设置开启时参与 classifyResponse */
  requires?: "sniffImages";
  /** 只参与 classify()，不参与 classifyResponse() */
  classifyOnly?: boolean;
  match: MatchSpec;
  /** 任一命中即视为本条规则不匹配 */
  exclude?: MatchSpec[];
  action: RuleAction;
}

/** 只支持 ${field} 替换，没有表达式 */
export type Template = string;

export type RuleAction =
  | {
      kind: "resource";
      type: ResourceType;
      confidence?: "high" | "medium" | "low";
    }
  | { kind: "ignore" }
  | { kind: "strip-params"; params: string[] }
  | { kind: "filename"; extFromQuery: string[] }
  | {
      kind: "track";
      source: "filenameOrUrl";
      pattern: string;
      group: number;
      audio: string[];
      video?: string[];
      fallback: "video" | "audio" | "none";
    }
  | {
      kind: "extract";
      when?: { path: string; equals: string | number | boolean }[];
      each?: string;
      fields: Record<string, string>;
      emit: EmitSpec;
    }
  | { kind: "dom"; selector: string; attr: string; emit: EmitSpec };

export interface EmitSpec {
  mode: "resource" | "preempt";
  url: Template | { resolve: { base: Template; ref: Template; bareQueryPrefix?: string } };
  filename?: Template;
  /** 缺省走 classify(url) */
  type?: ResourceType;
  quality?: Template;
}

export interface RevocationDoc {
  format: "fluxdown-sniff-revocations";
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  entries: {
    ruleId: string;
    versions: "*" | { max: number };
    action: "soft" | "hard";
    reason: string;
    ref?: string;
  }[];
}

export type RuleOverrides = Record<
  string,
  { enabled: boolean; ackRevocation?: number }
>;

/** 各 stage 允许的 action.kind。 */
export const STAGE_ACTIONS: Record<RuleStage, RuleAction["kind"][]> = {
  response: ["resource", "ignore"],
  normalize: ["strip-params", "filename"],
  track: ["track"],
  body: ["extract"],
  dom: ["dom"],
};
