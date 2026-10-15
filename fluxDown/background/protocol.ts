/**
 * 扩展内部消息契约（计划 C6）：background ↔ sensor / panel / popup / options / sidepanel。
 *
 * 纯类型 + 常量模块，零运行时依赖；UI、content script 与 background 共同 import。
 * 路由实现在 `background/messages.ts`，端口实现在 `background/ports.ts`。
 */
import type { SourceBufferBinding, PageConfig } from "@/page/bridge";
import type {
  ResponseDecision,
  ResponseInput,
  RuleListEntry,
  RuleRef,
} from "@/rules/engine";
import type { RulePack, RevocationDoc } from "@/rules/schema";
import type { DashManifest } from "@/utils/dash-manifest";
import type { MediaCandidate } from "@/utils/media-candidates";
import type { ResourceDebugLog } from "@/utils/resource-debug-log";
import type {
  DetectedResource,
  ResourceMessagePayload,
  ResourceType,
} from "@/utils/resource-types";
import type { SiteProfileFields } from "@/utils/site-profiles";

// ===== 媒体元素 =====

/** sensor 上报的媒体元素状态；frameId 由 background 用 sender.frameId 填写。 */
export interface ElementState {
  /** `${frameUid}:${n}`，frameUid = crypto.randomUUID().slice(0, 8)。 */
  key: string;
  frameId: number;
  tag: "video" | "audio";
  playing: boolean;
  visibleRatio: number;
  rect: { w: number; h: number };
  videoWidth: number;
  videoHeight: number;
  /** 仅 http(s)，否则 ""。 */
  currentSrc: string;
  lastPlayedAt: number;
  lastInteractionAt: number;
  bindings: SourceBufferBinding[];
  tracks: { kind: string; srclang: string; label: string; src: string }[];
}

// ===== 视图模型 =====

export interface CandidateRow {
  candidate: MediaCandidate;
  elementKey: string | null;
  playingVariantId: string | null;
  binding: "exact" | "temporal" | "none";
  ruleIds: string[];
}

export interface ResourceRow {
  resource: DetectedResource;
  ruleIds: string[];
}

export type HandoffState =
  | { kind: "unavailable"; reason: "disconnected" | "remote-mode" | "old-app" | "plugins-unsupported" }
  | { kind: "no-match"; installed: number }
  | { kind: "disabled"; identity: string; name: string }
  | { kind: "match"; identity: string; name: string };

export interface TabView {
  tabId: number;
  pageUrl: string;
  pageTitle: string;
  version: number;
  activeElementKey: string | null;
  playing: CandidateRow[];
  otherElements: CandidateRow[];
  unbound: CandidateRow[];
  files: ResourceRow[];
  hiddenLowConfidence: number;
  counts: Partial<Record<ResourceType | "all", number>>;
  handoff: HandoffState;
  site: { host: string; profileKey: string | null; profile: SiteProfileFields };
}

export interface ElementCandidates {
  rows: CandidateRow[];
}

// ===== 宿主 / 规则同步 =====

export interface ResolverInfo {
  identity: string;
  name: string;
  enabled: boolean;
  loaded: boolean;
  urls: string[];
}

export interface HostCapabilities {
  protocol: 1 | 2;
  pluginsSupported: boolean;
  resolvers: ResolverInfo[];
  connected: boolean;
}

/** 本地已存的规则包（storage.local `fluxdown_rule_packs`）。 */
export interface StoredRulePacks {
  official?: RulePack;
  community?: RulePack;
  revocations?: RevocationDoc;
  lastSyncAt?: number;
  lastError?: string;
}

export interface RuleDocSummary {
  sequence: number;
  issuedAt: string;
  expiresAt?: string;
}

export interface RuleSyncStatus {
  enabled: boolean;
  communityEnabled: boolean;
  official: RuleDocSummary | null;
  community: RuleDocSummary | null;
  revocations: RuleDocSummary | null;
  lastSyncAt: number | null;
  lastError: string | null;
  /** agent 侧最近拉取状态（sniff_rules 应答的 status）。 */
  host: { lastFetchUnix: number | null; lastError: string | null } | null;
}

export interface HostStatus {
  connected: boolean;
  protocol: 1 | 2;
  capabilities: HostCapabilities;
  ruleSync: RuleSyncStatus;
}

// ===== 消息 =====

export type SendChannel = "local" | "remote";

export interface SendResult {
  success: boolean;
  message?: string;
  channel?: SendChannel;
}

export interface PageLink {
  url: string;
  /** ≤ 120 字。 */
  text: string;
  tag: string;
}

export type RulesListEntry = RuleListEntry;

export interface RulesTestResult {
  response: ResponseDecision;
  track: "video" | "audio" | null;
  dedupeKey: string;
  fileExtension: string;
}

/** runtime.sendMessage 的请求（action 判别）与对应返回值。 */
export interface MessageMap {
  getPageConfig: { req: { pageUrl: string }; res: PageConfig };
  sensorReport: { req: { resources: ResourceMessagePayload[] }; res: { added: number } };
  manifestObserved: {
    req: { manifest: DashManifest; manifestUrl: string; pageUrl: string };
    res: { ok: boolean };
  };
  bodyObserved: {
    req: { url: string; pageUrl: string; ruleIds: string[]; text: string };
    res: { emitted: number };
  };
  /** sensor 执行 PageConfig.dom 规则的命中；background 用 engine.renderDomEmit 渲染后入库。 */
  domObserved: {
    req: { pageUrl: string; hits: { ruleId: string; value: string; text: string }[] };
    res: { emitted: number };
  };
  /** 侧边栏诊断「导出资源调试日志」：按 tab 生成已脱敏的嗅探状态快照。 */
  getDebugLog: { req: { tabId: number }; res: ResourceDebugLog };
  preemptDownload: { req: { url: string }; res: { ok: boolean } };
  pageUrlChanged: { req: { pageUrl: string }; res: { ok: boolean } };
  mediaElementState: {
    req: { elements: Omit<ElementState, "frameId">[]; removed: string[] };
    res: { ok: boolean };
  };
  contextTarget: { req: { elementKey: string | null }; res: { ok: boolean } };
  getElementCandidates: { req: { elementKey: string }; res: ElementCandidates };
  getTabView: { req: { tabId?: number }; res: TabView | null };
  downloadCandidate: {
    req: { tabId?: number; candidateId: string; variantId?: string; channel?: SendChannel };
    res: SendResult;
  };
  downloadResources: {
    req: { tabId?: number; resourceIds: string[]; channel?: SendChannel };
    res: SendResult;
  };
  downloadUrls: {
    req: { urls: string[]; referrer?: string; tabId?: number; channel?: SendChannel };
    res: SendResult;
  };
  handoffPage: { req: { tabId: number }; res: SendResult };
  clearResources: { req: { tabId?: number }; res: { ok: boolean } };
  collectLinks: { req: { tabId: number }; res: { links: PageLink[] } };
  openPanel: { req: Record<never, never>; res: { ok: boolean } };
  rulesTest: { req: ResponseInput; res: RulesTestResult };
  rulesSyncNow: { req: Record<never, never>; res: RuleSyncStatus };
  getHostStatus: { req: Record<never, never>; res: HostStatus };
  rulesList: { req: Record<never, never>; res: RulesListEntry[] };
}

export type MessageAction = keyof MessageMap;
export type MessageRequest<A extends MessageAction> = { action: A } & MessageMap[A]["req"];
export type MessageResponse<A extends MessageAction> = MessageMap[A]["res"];

/** background → content（tabs.sendMessage）。 */
export type ContentMessage =
  | { action: "pageConfigChanged" }
  | { action: "openPanel" }
  | { action: "getPageCharset" }
  | { action: "collectLinks" };

// ===== 端口 =====

export const TAB_VIEW_PORT = "tab-view";

/** UI → background：连接后先发订阅。"sender" = 端口所在 tab（content UI 用）。 */
export interface TabViewSubscribe {
  subscribe: number | "sender";
}

/** background → UI：订阅时与视图版本变化时推送；同一 tab 150 ms 内合并。 */
export interface TabViewPush {
  type: "tabView";
  view: TabView | null;
}

export type { RuleRef };
