/**
 * 按 tab 维护嗅探状态：资源、DASH 清单、媒体元素、已登记帧；变化时通知订阅者
 * （徽标、端口推送），并防抖持久化到 `storage.session`（SW 被回收后可恢复）。
 *
 * 入库流程：先跳过 blob/data → `engine.isIgnored` → `dedupeKey` 去重合并 →
 * `classify` → `resource-policy` → 淘汰。
 */
import { browser } from "wxt/browser";
import { hostOf } from "@/rules/url";
import { normalizeDashManifest } from "@/utils/dash-manifest";
import { isPageChange, pageUrlKey, type PageUrlChangeKind } from "@/utils/page-nav";
import type { DashManifest } from "@/utils/dash-manifest";
import { isManifestUrl, type DashManifestEntry } from "@/utils/media-candidates";
import type { HlsPlaylistEntry, HlsPlaylistInfo } from "@/utils/hls-playlist";
import { extractFilenameFromUrl } from "@/utils/resource-types";
import type {
  ConfidenceLevel,
  DetectedResource,
  ResourceMessagePayload,
} from "@/utils/resource-types";
import type { ElementState } from "./protocol";
import { computeConfidence, isWorthShowing } from "./resource-policy";
import { getEngine } from "./rules-store";
import { mergeRestoredTab } from "./tab-restore";
import type { PersistedTab } from "./tab-restore";

const CONFIDENCE_ORDER: Record<ConfidenceLevel, number> = { high: 3, medium: 2, low: 1 };

/** 每 tab 资源硬上限：防深扫 / 长会话 SPA 累积把内存与排序成本推高。 */
const MAX_RESOURCES_PER_TAB = 500;
const MAX_MANIFESTS_PER_TAB = 8;
/**
 * 分片类资源（m4s / ts 等、小于阈值的音视频）的单独上限：直播 / 长视频会持续产生分片，
 * 不能让它们挤掉页面里其它可下载资源；最新的分片已足够把播放元素关联到候选。
 */
const MAX_SEGMENTS_PER_TAB = 150;
const MAX_HLS_PLAYLISTS_PER_TAB = 64;
const MAX_PERSISTED_RESOURCES = 200;
const PERSIST_DEBOUNCE_MS = 1_000;
const SESSION_KEY_PREFIX = "fluxdown_tab_";

interface TabState {
  /** 最新的页面 URL（含 replaceState 改写后的 query）。 */
  pageUrl: string;
  /** 当前嗅探投影开始时的页面 URL；为空表示尚未登记。 */
  navUrl: string;
  /** 属于当前投影的页面 URL 键（navUrl 及其后未换页的 replaceState 改写）。 */
  pageKeys: Set<string>;
  resources: Map<string, DetectedResource>;
  manifests: Map<string, DashManifest>;
  /**
   * 换页前就已存在的清单键。播放器常在换页（SPA 跳转 / 自动连播）之前预取下一个视频的清单，
   * 换页清空会把它丢掉且不再上报；保留一代并标记为「换页前」，只在关联到播放元素后展示。
   */
  carriedManifests: Set<string>;
  /**
   * HLS 播放列表 URL 键 → 关联信息（子列表、分片目录）。只描述 URL 之间的关系、不生成候选，
   * 换页不清空：播放器可能在换页前就取到下一个视频的播放列表。
   */
  hlsPlaylists: Map<string, HlsPlaylistInfo>;
  elements: Map<string, ElementState>;
  frames: Set<number>;
  /** 最近一次右键命中的媒体元素 key。 */
  contextTarget: string | null;
  version: number;
}

const tabs = new Map<number, TabState>();
const changeListeners: Array<(tabId: number) => void> = [];

function stateOf(tabId: number): TabState {
  let state = tabs.get(tabId);
  if (!state) {
    state = {
      pageUrl: "",
      navUrl: "",
      pageKeys: new Set(),
      resources: new Map(),
      manifests: new Map(),
      carriedManifests: new Set(),
      hlsPlaylists: new Map(),
      elements: new Map(),
      frames: new Set(),
      contextTarget: null,
      version: 0,
    };
    tabs.set(tabId, state);
  }
  return state;
}

/** 订阅 tab 状态变化（任何资源 / 清单 / 元素 / 页面 URL 变化）。 */
export function onTabChanged(listener: (tabId: number) => void): void {
  changeListeners.push(listener);
}

function touch(tabId: number): void {
  stateOf(tabId).version++;
  schedulePersist(tabId);
  for (const listener of changeListeners) listener(tabId);
}

export function getTabVersion(tabId: number): number {
  return tabs.get(tabId)?.version ?? 0;
}

// ===== 页面 URL / 导航 =====

export { pageUrlKey };

export function getTabPageUrl(tabId: number): string {
  return tabs.get(tabId)?.pageUrl ?? "";
}

/**
 * 清空一个 tab 的嗅探投影；`keepFrames` 用于同文档导航（SPA 路由）。
 * `carryManifests`：同站换页时把现有清单留作换页前清单（见 carriedManifests），跨站则全部丢弃。
 */
function clearTab(tabId: number, keepFrames: boolean, carryManifests: boolean): void {
  const state = tabs.get(tabId);
  if (!state) return;
  // 播放清单资源（.m3u8 / .mpd）同样保留一代：HLS 主列表在换页前预取时，换页后的分片要靠它归属。
  const carriedResources = carryManifests
    ? [...state.resources.values()].filter((r) => !r.carried && isManifestUrl(r.url, r.mimeType))
    : [];
  state.resources.clear();
  for (const resource of carriedResources) state.resources.set(resource.id, { ...resource, carried: true });
  // 已经跨过一次换页的清单不再保留；其余标记为换页前清单。
  for (const key of state.carriedManifests) state.manifests.delete(key);
  if (!carryManifests) state.manifests.clear();
  state.carriedManifests = new Set(state.manifests.keys());
  state.elements.clear();
  state.contextTarget = null;
  if (!keepFrames) state.frames.clear();
  touch(tabId);
}

/**
 * 同步 tab 的页面 URL；换页（见 `isPageChange`）时清空投影。
 *
 * push / pop / document 以「URL 键不属于当前投影」判定，因为 tabs.onUpdated 可能先到并已
 * 改写 `pageUrl`；replace / tab 只看路径是否离开投影起点。replaceState 未换页时把新键并入
 * 投影，旧 URL 下发出的上报仍被接受。
 */
export function syncTabPageUrl(tabId: number, pageUrl: string, kind: PageUrlChangeKind): void {
  if (!pageUrl) return;
  const state = stateOf(tabId);
  const key = pageUrlKey(pageUrl);
  const changed =
    state.navUrl !== "" &&
    (kind === "replace" || kind === "tab" ? isPageChange(kind, state.navUrl, pageUrl) : !state.pageKeys.has(key));
  const previous = state.pageUrl;
  const previousNav = state.navUrl;
  state.pageUrl = pageUrl;
  if (state.navUrl === "" || changed) {
    state.navUrl = pageUrl;
    state.pageKeys = new Set([key]);
  } else if (kind !== "tab") {
    // tabs.onUpdated 可能是 query 级整页导航的前奏：不并入，等 content 的 push / document 判定。
    state.pageKeys.add(key);
  }
  if (changed) clearTab(tabId, kind !== "tab", hostOf(previousNav) === hostOf(pageUrl));
  else if (previous !== pageUrl) touch(tabId);
}

/** 上报所属页面是否属于当前嗅探投影（空 URL 视为属于）。 */
export function isCurrentPage(tabId: number, pageUrl: string): boolean {
  const state = tabs.get(tabId);
  if (!pageUrl || !state || state.navUrl === "") return true;
  return state.pageKeys.has(pageUrlKey(pageUrl));
}

/** 关闭 tab：丢弃内存状态、取消待写的持久化并清掉会话快照。不通知变更订阅者（tab 已不存在，无视图可刷新）。 */
export function removeTab(tabId: number): void {
  tabs.delete(tabId);
  clearTimeout(persistTimers.get(tabId));
  persistTimers.delete(tabId);
  const index = persistedOrder.indexOf(tabId);
  if (index >= 0) persistedOrder.splice(index, 1);
  void browser.storage.session?.remove(`${SESSION_KEY_PREFIX}${tabId}`).catch(() => {});
}

// ===== 帧 =====

export function registerFrame(tabId: number, frameId: number): void {
  stateOf(tabId).frames.add(frameId);
}

export function framesOf(tabId: number): number[] {
  return [...(tabs.get(tabId)?.frames ?? [])];
}

/** 所有已登记帧（tabId → frameIds），供 PageConfig 失效广播。 */
export function allFrames(): [number, number[]][] {
  return [...tabs].map(([tabId, state]) => [tabId, [...state.frames]]);
}

/** 只清空嗅探到的资源与清单（用户点「清空」）；保留媒体元素与帧登记。 */
export function clearResourcesOnly(tabId: number): void {
  const state = tabs.get(tabId);
  if (!state) return;
  state.resources.clear();
  state.manifests.clear();
  state.carriedManifests.clear();
  state.hlsPlaylists.clear();
  touch(tabId);
}

// ===== 资源 =====

export interface IngestContext {
  frameId?: number;
  ruleIds?: string[];
  cookies?: string;
  headers?: Record<string, string>;
}

function hasExtension(name: string): boolean {
  return /\.[A-Za-z0-9]{1,10}$/.test(name);
}

function lastSegment(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
  } catch {
    return "";
  }
}

/** 文件名补全：URL 末段没有扩展名时，用规则引擎的 `fileExtension` 补（#783：X.com 图片）。 */
function completeFilename(url: string, pageUrl: string, filename: string | undefined): string {
  const base = filename || extractFilenameFromUrl(url) || lastSegment(url);
  if (!base || hasExtension(base)) return base;
  const ext = getEngine().fileExtension(url, pageUrl);
  return ext ? `${base}.${ext}` : base;
}

const SEGMENT_EXT_RE = /\.(?:m4s|ts|m4v|m4a|cmfv|cmfa|aac)(?:[?#]|$)/i;

/** 分片类资源：媒体分片扩展名，或小于阈值（low）的音视频 / 流。 */
function isSegmentLike(resource: DetectedResource): boolean {
  if (resource.type !== "video" && resource.type !== "audio" && resource.type !== "stream") return false;
  if (isManifestUrl(resource.url, resource.mimeType)) return false;
  return SEGMENT_EXT_RE.test(resource.url) || resource.confidence === "low";
}

/** 分片类资源超过 `keep` 条时按检测时间淘汰最旧的。 */
function evictOldestSegments(map: Map<string, DetectedResource>, keep: number): void {
  const segments = [...map.values()].filter(isSegmentLike);
  if (segments.length <= keep) return;
  segments.sort((a, b) => a.detectedAt - b.detectedAt);
  for (const victim of segments.slice(0, segments.length - keep)) map.delete(victim.id);
}

function evictLowest(map: Map<string, DetectedResource>): void {
  let victimKey: string | undefined;
  let victimScore = Infinity;
  let victimAt = Infinity;
  for (const [key, r] of map) {
    const score = CONFIDENCE_ORDER[r.confidence];
    if (score < victimScore || (score === victimScore && r.detectedAt < victimAt)) {
      victimScore = score;
      victimAt = r.detectedAt;
      victimKey = key;
    }
  }
  if (victimKey !== undefined) map.delete(victimKey);
}

function mergeRuleIds(existing: DetectedResource, ruleIds: string[] | undefined): boolean {
  if (!ruleIds || ruleIds.length === 0) return false;
  const merged = new Set([...(existing.ruleIds ?? []), ...ruleIds]);
  if (merged.size === (existing.ruleIds?.length ?? 0)) return false;
  existing.ruleIds = [...merged];
  return true;
}

/** 合并重复命中的资源；返回是否有字段真的变化（同一分片 / Range 的重复请求通常没有）。 */
function mergeResource(
  existing: DetectedResource,
  incoming: ResourceMessagePayload,
  ctx: IngestContext,
): boolean {
  let changed = false;
  if (existing.type === "other" && incoming.type && incoming.type !== "other") {
    existing.type = incoming.type;
    changed = true;
  }
  if (!existing.filename && incoming.filename) {
    existing.filename = incoming.filename;
    changed = true;
  }
  if (existing.size <= 0 && incoming.size && incoming.size > 0) {
    existing.size = incoming.size;
    changed = true;
  }
  if (!existing.mimeType && incoming.mimeType) {
    existing.mimeType = incoming.mimeType;
    changed = true;
  }
  if (!existing.quality && incoming.quality) {
    existing.quality = incoming.quality;
    changed = true;
  }
  if (incoming.isAttachment && !existing.isAttachment) {
    existing.isAttachment = true;
    changed = true;
  }
  if (!existing.lang && incoming.lang) {
    existing.lang = incoming.lang;
    changed = true;
  }
  if (!existing.label && incoming.label) {
    existing.label = incoming.label;
    changed = true;
  }
  if (!existing.elementKey && incoming.elementKey) {
    existing.elementKey = incoming.elementKey;
    changed = true;
  }
  // 同一媒体路径的签名/token 轮换会归并为同一 id：以最新 URL 与认证头为准，
  // 否则下载用的是已过期的首次链接。
  if (incoming.url !== existing.url) {
    existing.url = incoming.url;
    existing.detectedAt = Date.now();
    if (ctx.cookies) existing.cookies = ctx.cookies;
    if (ctx.headers && Object.keys(ctx.headers).length > 0) existing.headers = ctx.headers;
    changed = true;
  }
  if (ctx.cookies && !existing.cookies) {
    existing.cookies = ctx.cookies;
    changed = true;
  }
  if (ctx.headers && Object.keys(ctx.headers).length > 0 && !existing.headers) {
    existing.headers = ctx.headers;
    changed = true;
  }
  if (mergeRuleIds(existing, ctx.ruleIds)) changed = true;
  // 只在 API JSON 里出现过的地址后来被页面真正请求：按真实请求重新评估可信度。
  if (existing.detectedBy === "api-scan" && incoming.detectedBy !== "api-scan") {
    existing.detectedBy = incoming.detectedBy;
    changed = true;
  }
  // 换页后页面又请求了这份清单：它属于当前页
  if (existing.carried) {
    delete existing.carried;
    changed = true;
  }

  // 重新计算可信度（信息更丰富后可能升级）
  const next = computeConfidence(existing.type, existing.size, existing.detectedBy, existing.isAttachment);
  if (CONFIDENCE_ORDER[next] > CONFIDENCE_ORDER[existing.confidence]) {
    existing.confidence = next;
    changed = true;
  }
  return changed;
}

/**
 * 入库一批资源；返回新增数量。新增或合并出变化时才通知订阅者（持久化、视图重建、徽标）。
 * blob:/data: 在此处丢弃（magnet 例外）。
 */
export function ingestResources(
  tabId: number,
  pageUrl: string,
  payloads: ResourceMessagePayload[],
  ctx: IngestContext = {},
): number {
  const state = stateOf(tabId);
  const engine = getEngine();
  let added = 0;
  let changed = false;

  for (const payload of payloads) {
    const url = payload.url;
    if (!url || url.startsWith("blob:") || url.startsWith("data:")) continue;
    const effectivePageUrl = payload.pageUrl || pageUrl || state.pageUrl;
    if (engine.isIgnored(url, effectivePageUrl, payload.isAttachment === true)) continue;

    const id = engine.dedupeKey(url, effectivePageUrl);
    const existing = state.resources.get(id);
    if (existing) {
      if (mergeResource(existing, payload, ctx)) changed = true;
      continue;
    }

    const type = payload.type !== "other" ? payload.type : engine.classify(url, payload.mimeType);
    const size = payload.size ?? -1;
    const resource: DetectedResource = {
      id,
      url,
      filename: completeFilename(url, effectivePageUrl, payload.filename),
      type,
      size,
      mimeType: payload.mimeType,
      quality: payload.quality,
      detectedBy: payload.detectedBy,
      detectedAt: Date.now(),
      tabId,
      pageUrl: effectivePageUrl,
      confidence: computeConfidence(type, size, payload.detectedBy, payload.isAttachment),
      isAttachment: payload.isAttachment,
      cookies: ctx.cookies || undefined,
      headers: ctx.headers && Object.keys(ctx.headers).length > 0 ? ctx.headers : undefined,
      ruleIds: ctx.ruleIds && ctx.ruleIds.length > 0 ? [...ctx.ruleIds] : undefined,
      frameId: ctx.frameId,
      elementKey: payload.elementKey,
      lang: payload.lang,
      label: payload.label,
    };
    if (!isWorthShowing(resource)) continue;
    if (isSegmentLike(resource)) evictOldestSegments(state.resources, MAX_SEGMENTS_PER_TAB - 1);
    if (state.resources.size >= MAX_RESOURCES_PER_TAB) evictLowest(state.resources);
    state.resources.set(id, resource);
    added++;
    changed = true;
  }

  if (changed) touch(tabId);
  return added;
}

/** 按可信度降序、检测时间降序排列的资源。 */
export function getResources(tabId: number): DetectedResource[] {
  const state = tabs.get(tabId);
  if (!state) return [];
  return [...state.resources.values()].sort((a, b) => {
    const diff = CONFIDENCE_ORDER[b.confidence] - CONFIDENCE_ORDER[a.confidence];
    return diff !== 0 ? diff : b.detectedAt - a.detectedAt;
  });
}

// ===== DASH 清单 =====

/** 保存一份 DASH 清单（同 URL 取最新，按 tab 有界）；非法清单返回 false。 */
export function addManifest(
  tabId: number,
  manifestUrl: string,
  rawManifest: unknown,
  pageUrl: string,
): boolean {
  const manifest = normalizeDashManifest(rawManifest);
  if (!manifest) return false;
  const state = stateOf(tabId);
  const key = manifestUrl ? getEngine().dedupeKey(manifestUrl, pageUrl || state.pageUrl) : "__legacy__";
  state.manifests.delete(key);
  state.manifests.set(key, manifest);
  state.carriedManifests.delete(key);
  while (state.manifests.size > MAX_MANIFESTS_PER_TAB) {
    const oldest = state.manifests.keys().next().value;
    if (typeof oldest !== "string") break;
    state.manifests.delete(oldest);
    state.carriedManifests.delete(oldest);
  }
  touch(tabId);
  return true;
}

export function getManifests(tabId: number): DashManifestEntry[] {
  const state = tabs.get(tabId);
  if (!state) return [];
  return [...state.manifests.entries()].map(([url, manifest]) =>
    state.carriedManifests.has(url) ? { url, manifest, carried: true } : { url, manifest },
  );
}

/** 保存一份 HLS 播放列表的关联信息（同 URL 取最新，按 tab 有界）。 */
export function addHlsPlaylist(tabId: number, url: string, playlist: HlsPlaylistInfo, pageUrl: string): void {
  const state = stateOf(tabId);
  const key = getEngine().dedupeKey(url, pageUrl || state.pageUrl);
  state.hlsPlaylists.delete(key);
  state.hlsPlaylists.set(key, playlist);
  while (state.hlsPlaylists.size > MAX_HLS_PLAYLISTS_PER_TAB) {
    const oldest = state.hlsPlaylists.keys().next().value;
    if (typeof oldest !== "string") break;
    state.hlsPlaylists.delete(oldest);
  }
  touch(tabId);
}

export function getHlsPlaylists(tabId: number): HlsPlaylistEntry[] {
  const state = tabs.get(tabId);
  if (!state) return [];
  return [...state.hlsPlaylists.entries()].map(([url, playlist]) => ({ url, playlist }));
}

// ===== 媒体元素 =====

export function updateElements(
  tabId: number,
  frameId: number,
  elements: Omit<ElementState, "frameId">[],
  removed: string[],
): void {
  const state = stateOf(tabId);
  for (const key of removed) state.elements.delete(key);
  for (const element of elements) state.elements.set(element.key, { ...element, frameId });
  touch(tabId);
}

export function getElements(tabId: number): ElementState[] {
  return [...(tabs.get(tabId)?.elements.values() ?? [])];
}

export function setContextTarget(tabId: number, elementKey: string | null): void {
  stateOf(tabId).contextTarget = elementKey;
}

export function getContextTarget(tabId: number): string | null {
  return tabs.get(tabId)?.contextTarget ?? null;
}

// ===== 下载时取回嗅探到的认证信息 =====

/** 在 tab 资源里按 URL 找原始请求；签名参数顺序不同时用同一套 dedupeKey 归一化。 */
export function findStoredResource(
  stored: DetectedResource[],
  url: string,
): DetectedResource | undefined {
  const exact = stored.find((resource) => resource.url === url);
  if (exact) return exact;
  const engine = getEngine();
  const key = (u: string) => engine.dedupeKey(u, "");
  const normalized = key(url);
  return stored.find((resource) => key(resource.url) === normalized);
}

export function mergeStoredHeaders(
  primary: Record<string, string> | undefined,
  secondary: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!primary && !secondary) return undefined;
  const merged = { ...(secondary || {}), ...(primary || {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function sameOrigin(firstUrl: string, secondUrl: string): boolean {
  try {
    return new URL(firstUrl).origin === new URL(secondUrl).origin;
  } catch {
    return false;
  }
}

// ===== 持久化（storage.session） =====

const persistTimers = new Map<number, ReturnType<typeof setTimeout>>();
/** 写入顺序（最旧在前），配额不足时淘汰最旧的键。 */
const persistedOrder: number[] = [];

/** SW 启动时的恢复任务；持久化要等它结束，避免空状态抢先覆盖旧快照。 */
let restoreReady: Promise<void> = Promise.resolve();

/** 等会话快照恢复完成（读视图前调用；恢复失败也会 resolve）。 */
export function whenRestored(): Promise<void> {
  return restoreReady;
}

function schedulePersist(tabId: number): void {
  if (!browser.storage.session || persistTimers.has(tabId)) return;
  persistTimers.set(
    tabId,
    setTimeout(() => {
      persistTimers.delete(tabId);
      void persistTab(tabId);
    }, PERSIST_DEBOUNCE_MS),
  );
}

function snapshotOf(tabId: number): PersistedTab | null {
  const state = tabs.get(tabId);
  if (!state) return null;
  return {
    pageUrl: state.pageUrl,
    resources: getResources(tabId)
      .slice(0, MAX_PERSISTED_RESOURCES)
      .map(({ cookies: _cookies, ...rest }) => rest),
    manifests: getManifests(tabId),
    hlsPlaylists: getHlsPlaylists(tabId),
    elements: [...state.elements.values()],
  };
}

async function persistTab(tabId: number): Promise<void> {
  await restoreReady;
  const session = browser.storage.session;
  const snapshot = snapshotOf(tabId);
  if (!session || !snapshot) return;
  const entry = { [`${SESSION_KEY_PREFIX}${tabId}`]: snapshot };
  try {
    await session.set(entry);
  } catch (e) {
    // QUOTA_BYTES：删掉最旧 tab 的键再重试一次。
    const victim = persistedOrder.find((id) => id !== tabId);
    if (victim === undefined) {
      console.warn("[FluxDown] persist tab state failed:", e);
      return;
    }
    persistedOrder.splice(persistedOrder.indexOf(victim), 1);
    try {
      await session.remove(`${SESSION_KEY_PREFIX}${victim}`);
      await session.set(entry);
    } catch (retryError) {
      console.warn("[FluxDown] persist tab state failed after eviction:", retryError);
      return;
    }
  }
  if (!tabs.has(tabId)) {
    // 写入期间 tab 已关闭：把刚写入的键清掉，且不登记写入顺序。
    void session.remove(`${SESSION_KEY_PREFIX}${tabId}`).catch(() => {});
    return;
  }
  const index = persistedOrder.indexOf(tabId);
  if (index >= 0) persistedOrder.splice(index, 1);
  persistedOrder.push(tabId);
}

/** SW 启动时恢复仍存在的 tab 的状态。 */
export async function restoreTabState(): Promise<void> {
  const session = browser.storage.session;
  if (!session) return;
  try {
    const [all, openTabs] = await Promise.all([session.get(null), browser.tabs.query({})]);
    const currentUrls = new Map(openTabs.map((tab) => [tab.id, tab.url]));
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(SESSION_KEY_PREFIX)) continue;
      const tabId = Number(key.slice(SESSION_KEY_PREFIX.length));
      if (!Number.isInteger(tabId)) continue;
      if (!currentUrls.has(tabId)) {
        void session.remove(key).catch(() => {});
        continue;
      }
      // 启动期间可能已有实时数据（消息唤醒 SW）：合并而不是跳过，实时数据优先。
      const state = stateOf(tabId);
      if (!mergeRestoredTab(state, value as PersistedTab, currentUrls.get(tabId), normalizeDashManifest)) {
        void session.remove(key).catch(() => {});
        continue;
      }
      if (state.navUrl === "" && state.pageUrl) {
        state.navUrl = state.pageUrl;
        state.pageKeys = new Set([pageUrlKey(state.pageUrl)]);
      }
      if (!persistedOrder.includes(tabId)) persistedOrder.push(tabId);
      for (const listener of changeListeners) listener(tabId);
    }
  } catch (e) {
    console.warn("[FluxDown] restore tab state failed:", e);
  }
}

// ===== 生命周期 =====

/** 同步注册 tab 生命周期监听；由 startBackground 调用一次。 */
export function installTabState(): void {
  browser.tabs.onRemoved.addListener((tabId) => removeTab(tabId));
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo.url) return;
    // 整页导航与同文档 pushState / replaceState 在这里都报 status:"loading"，无法区分：
    // 只按路径换页，query 级换页交给 content 的 push / pop / document 上报。
    syncTabPageUrl(tabId, changeInfo.url, "tab");
  });
  restoreReady = restoreTabState();
}
