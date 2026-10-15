/**
 * TabView 视图模型。核心 `composeTabView` 是纯函数（可在 bun 下测试）：
 * 资源 + DASH 清单 + 媒体元素 → 候选 → 绑定到元素 → 分组（当前播放 / 其它元素 / 未关联 / 文件）。
 *
 * 取数（tab-state / settings / host）在 `tab-view.ts`，本文件保持零 browser 依赖。
 */
import { urlGlobMatch } from "@/rules/glob";
import type { CompiledRules } from "@/rules/engine";
import type { DashManifest } from "@/utils/dash-manifest";
import {
  buildMediaCandidates,
  isMediaCandidateVisible,
} from "@/utils/media-candidates";
import type { MediaCandidate, MediaCandidateVariant } from "@/utils/media-candidates";
import type { DetectedResource, ResourceType } from "@/utils/resource-types";
import type { RemoteMode } from "@/utils/settings";
import { activeElement, bindCandidates } from "./media-binding";
import type { CandidateBinding } from "./media-binding";
import type {
  CandidateRow,
  ElementState,
  HandoffState,
  HostCapabilities,
  ResourceRow,
  TabView,
} from "./protocol";

// ===== 音视频轨配对（迁自 utils/resource-types.groupTrackPairs，判轨改为 engine.trackKind） =====

/** 一组「清晰度 + 视频轨 + 可选音频轨」的下载配对。 */
export interface TrackPairGroup {
  /** 清晰度标签：优先取 DetectedResource.quality，否则按 size 降序生成占位档位名 */
  quality: string;
  videoUrl: string;
  /** 缺省 = 该清晰度无独立音频轨，视频轨可单独直下 */
  audioUrl?: string;
  videoRes: DetectedResource;
  audioRes?: DetectedResource;
}

export type TrackKindOf = (resource: DetectedResource) => "video" | "audio" | null;

/**
 * 把一个 tab 内嗅探到的媒体资源（video/audio/stream）按轨道类型 + 清晰度分组为
 * 「视频轨 + 共享音频轨」列表。判轨由 `trackKindOf`（engine.trackKind）给出；
 * 判不出的（null）：只有 1 条时归为视频轨；≥2 条且大小均已知时最小的一条视为音频轨，
 * 其余视频轨；否则全部归为独立视频轨，不猜测音频配对。音频轨取体积最大的一条供各视频档共用。
 */
export function groupTrackPairs(
  resources: DetectedResource[],
  trackKindOf: TrackKindOf,
): TrackPairGroup[] {
  const candidates = resources.filter(
    (r) => r.type === "video" || r.type === "audio" || r.type === "stream",
  );
  if (candidates.length === 0) return [];

  const videoTracks: DetectedResource[] = [];
  const audioTracks: DetectedResource[] = [];
  const unknown: DetectedResource[] = [];
  for (const r of candidates) {
    const kind = trackKindOf(r);
    if (kind === "audio") audioTracks.push(r);
    else if (kind === "video") videoTracks.push(r);
    else unknown.push(r);
  }

  if (unknown.length === 1) {
    videoTracks.push(unknown[0]);
  } else if (unknown.length >= 2) {
    if (unknown.every((r) => r.size > 0)) {
      const sorted = [...unknown].sort((a, b) => b.size - a.size);
      audioTracks.push(sorted[sorted.length - 1]);
      videoTracks.push(...sorted.slice(0, -1));
    } else {
      videoTracks.push(...unknown);
    }
  }

  if (videoTracks.length === 0) return [];

  const sharedAudio =
    audioTracks.length > 0
      ? audioTracks.reduce((best, cur) => (cur.size > best.size ? cur : best))
      : undefined;
  const sortedVideo = [...videoTracks].sort((a, b) => b.size - a.size);
  return sortedVideo.map((v, idx) => ({
    quality: v.quality || `画质${idx + 1}`,
    videoUrl: v.url,
    audioUrl: sharedAudio?.url,
    videoRes: v,
    audioRes: sharedAudio,
  }));
}

// ===== 转交桌面端解析（HandoffState） =====

export interface HandoffInput {
  remoteMode: RemoteMode;
  caps: HostCapabilities;
  pageUrl: string;
}

export function handoffFor({ remoteMode, caps, pageUrl }: HandoffInput): HandoffState {
  if (remoteMode === "always") return { kind: "unavailable", reason: "remote-mode" };
  if (!caps.connected) return { kind: "unavailable", reason: "disconnected" };
  if (caps.protocol === 1) return { kind: "unavailable", reason: "old-app" };
  if (!caps.pluginsSupported) return { kind: "unavailable", reason: "plugins-unsupported" };

  let disabled: HandoffState | null = null;
  for (const resolver of caps.resolvers) {
    if (!resolver.urls.some((pattern) => urlGlobMatch(pattern, pageUrl))) continue;
    if (resolver.enabled && resolver.loaded) {
      return { kind: "match", identity: resolver.identity, name: resolver.name };
    }
    disabled ??= { kind: "disabled", identity: resolver.identity, name: resolver.name };
  }
  return disabled ?? { kind: "no-match", installed: caps.resolvers.length };
}

// ===== 视图模型核心 =====

export interface ViewModelInput {
  tabId: number;
  pageUrl: string;
  pageTitle: string;
  version: number;
  resources: DetectedResource[];
  manifests: { url: string; manifest: DashManifest }[];
  elements: ElementState[];
  engine: Pick<CompiledRules, "dedupeKey" | "trackKind">;
  showLowConfidence: boolean;
  handoff: HandoffState;
  site: TabView["site"];
}

const MEDIA_TYPES: ReadonlySet<ResourceType> = new Set(["video", "stream", "audio"]);

function rowCount(candidate: MediaCandidate): number {
  return Math.max(candidate.variants.length, 1);
}

/** 元素同时绑定 video 与 audio 两类 SourceBuffer。 */
function hasBothKinds(element: ElementState): boolean {
  const kinds = new Set(element.bindings.map((b) => b.kind));
  return kinds.has("video") && kinds.has("audio");
}

/** 直链播放（currentSrc）而候选里没有对应项时，为元素合成一个单 variant 候选。 */
function synthesizeCurrentSrc(
  element: ElementState,
  existing: MediaCandidate[],
  key: (u: string) => string,
  pageTitle: string,
  pageUrl: string,
): MediaCandidate | null {
  if (!element.currentSrc) return null;
  const k = key(element.currentSrc);
  const covered = existing.some((c) =>
    c.variants.some((v) => key(v.videoUrl) === k || (v.audioUrl && key(v.audioUrl) === k)),
  );
  if (covered) return null;
  const id = `element:${element.key}`;
  return {
    id,
    title: pageTitle || "Video",
    type: "video",
    source: "direct",
    pageUrl,
    variants: [
      {
        id: `${id}:0`,
        label: element.videoHeight > 0 ? `${element.videoHeight}p` : "original",
        videoUrl: element.currentSrc,
      },
    ],
    rawResourceIds: [],
    fragmentCount: 0,
    downloadable: true,
  };
}

/** 唯一同时绑定音视频 SourceBuffer 的元素：把其 exact 命中的两条轨配成候选（#657）。 */
function synthesizePair(
  element: ElementState,
  resources: DetectedResource[],
  existing: MediaCandidate[],
  input: ViewModelInput,
  key: (u: string) => string,
): MediaCandidate | null {
  const exact = new Set(element.bindings.flatMap((b) => b.exact.map(key)));
  const used = resources.filter((r) => exact.has(key(r.url)));
  const groups = groupTrackPairs(used, (r) =>
    input.engine.trackKind({ url: r.url, filename: r.filename, mime: r.mimeType, pageUrl: input.pageUrl }),
  ).filter((g) => g.audioUrl);
  if (groups.length === 0) return null;

  const covered = existing.some((c) =>
    c.variants.some((v) => groups.some((g) => key(v.videoUrl) === key(g.videoUrl))),
  );
  if (covered) return null;

  const id = `pair:${element.key}`;
  const variants: MediaCandidateVariant[] = groups.map((g, i) => ({
    id: `${id}:${i}`,
    label: g.videoRes.quality || (element.videoHeight > 0 ? `${element.videoHeight}p` : g.quality),
    videoUrl: g.videoUrl,
    audioUrl: g.audioUrl,
    mimeType: g.videoRes.mimeType,
    fileSize: g.videoRes.size > 0 ? g.videoRes.size : undefined,
    resourceId: g.videoRes.id,
  }));
  return {
    id,
    title: input.pageTitle || "Video",
    type: "video",
    source: "direct",
    pageUrl: input.pageUrl,
    variants,
    rawResourceIds: groups.flatMap((g) => [g.videoRes.id, g.audioRes?.id ?? ""]).filter(Boolean),
    fragmentCount: 0,
    downloadable: true,
  };
}

function isLowConfidence(candidate: MediaCandidate, byId: Map<string, DetectedResource>): boolean {
  if (candidate.source !== "direct" && candidate.source !== "fragments") return false;
  const raws = candidate.rawResourceIds
    .map((id) => byId.get(id))
    .filter((r): r is DetectedResource => !!r);
  return raws.length > 0 && raws.every((r) => r.confidence === "low");
}

export function composeTabView(input: ViewModelInput): TabView {
  const { engine, resources, elements } = input;
  const key = (url: string) => engine.dedupeKey(url, input.pageUrl);
  const byId = new Map(resources.map((r) => [r.id, r]));

  const built = buildMediaCandidates(resources, {
    fallbackTitle: "Video",
    pageTitle: input.pageTitle,
    pageUrl: input.pageUrl,
    manifests: input.manifests,
    key,
  });
  const candidates = [...built];
  for (const element of elements) {
    const synthesized = synthesizeCurrentSrc(element, candidates, key, input.pageTitle, input.pageUrl);
    if (synthesized) candidates.push(synthesized);
  }
  const pairElements = elements.filter(hasBothKinds);
  if (pairElements.length === 1) {
    const pair = synthesizePair(pairElements[0], resources, candidates, input, key);
    if (pair) candidates.push(pair);
  }

  const bindings = bindCandidates(candidates, elements, key);
  const active = activeElement(elements);
  const rows = (candidate: MediaCandidate, binding: CandidateBinding | undefined): CandidateRow => ({
    candidate,
    elementKey: binding?.elementKey ?? null,
    playingVariantId: binding?.playingVariantId ?? null,
    binding: binding?.confidence ?? "none",
    ruleIds: [
      ...new Set(candidate.rawResourceIds.flatMap((id) => byId.get(id)?.ruleIds ?? [])),
    ],
  });

  const playing: CandidateRow[] = [];
  const otherElements: CandidateRow[] = [];
  const unbound: CandidateRow[] = [];
  let hiddenLowConfidence = 0;
  const counts: TabView["counts"] = {};
  const addCount = (type: ResourceType, n: number) => {
    counts[type] = (counts[type] ?? 0) + n;
    counts.all = (counts.all ?? 0) + n;
  };

  for (const candidate of candidates) {
    const synthetic = candidate.id.startsWith("element:") || candidate.id.startsWith("pair:");
    if (!synthetic && !isMediaCandidateVisible(candidate, candidates)) continue;
    const binding = bindings.get(candidate.id);
    if (!binding && !input.showLowConfidence && isLowConfidence(candidate, byId)) {
      hiddenLowConfidence++;
      continue;
    }
    const row = rows(candidate, binding);
    if (binding && active && binding.elementKey === active.key) playing.push(row);
    else if (binding) otherElements.push(row);
    else unbound.push(row);
    addCount(candidate.type, rowCount(candidate));
  }

  const represented = new Set(candidates.flatMap((c) => c.rawResourceIds));
  const files: ResourceRow[] = [];
  for (const resource of resources) {
    if (MEDIA_TYPES.has(resource.type) || represented.has(resource.id)) continue;
    if (resource.confidence === "low" && !input.showLowConfidence) {
      hiddenLowConfidence++;
      continue;
    }
    files.push({ resource, ruleIds: resource.ruleIds ?? [] });
    addCount(resource.type, 1);
  }

  return {
    tabId: input.tabId,
    pageUrl: input.pageUrl,
    pageTitle: input.pageTitle,
    version: input.version,
    activeElementKey: active?.key ?? null,
    playing,
    otherElements,
    unbound,
    files,
    hiddenLowConfidence,
    counts,
    handoff: input.handoff,
    site: input.site,
  };
}

/** 徽标数 = playing / otherElements / unbound 各候选的 max(variants,1) 之和 + files.length。 */
export function badgeCount(view: TabView): number {
  const rowsTotal = [...view.playing, ...view.otherElements, ...view.unbound].reduce(
    (sum, row) => sum + rowCount(row.candidate),
    0,
  );
  return rowsTotal + view.files.length;
}

/** 绑定到某元素的候选行（浮钮 / 右键菜单用）。 */
export function rowsForElement(view: TabView, elementKey: string): CandidateRow[] {
  return [...view.playing, ...view.otherElements].filter((row) => row.elementKey === elementKey);
}

/** 视图里所有候选行。 */
export function allRows(view: TabView): CandidateRow[] {
  return [...view.playing, ...view.otherElements, ...view.unbound];
}
