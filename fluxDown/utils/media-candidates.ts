/**
 * 将嗅探到的原始媒体请求投影为用户真正能理解的「视频候选」。
 *
 * background/tab-state 保留原始请求，便于认证信息恢复和高级诊断；本模块只负责
 * UI/下载层的聚合，不把 m4s/ts 分片伪装成独立视频。
 */

import type { DashManifest } from "./dash-manifest";
import type { DetectedResource } from "./resource-types";
import { extractFilenameFromUrl, isStreamingUrl } from "./resource-types";
import { extractExtension } from "@/rules/url";
import { normalizeDashManifest } from "./dash-manifest";

export type MediaCandidateSource =
  | "direct"
  | "hls"
  | "dash"
  | "fragments"
  | "ignored";

export interface DashManifestEntry {
  url: string;
  manifest: DashManifest;
}

export interface MediaCandidateVariant {
  id: string;
  /** UI-facing stable label: "1080p", "720p", or "auto". */
  label: string;
  videoUrl: string;
  audioUrl?: string;
  mimeType?: string;
  bandwidth?: number;
  codec?: string;
  frameRate?: number;
  fileSize?: number;
  resourceId?: string;
}

export interface MediaCandidate {
  id: string;
  title: string;
  type: "video" | "stream";
  source: MediaCandidateSource;
  pageUrl: string;
  variants: MediaCandidateVariant[];
  /** Raw resource IDs retained for diagnostics and fragment count display. */
  rawResourceIds: string[];
  fragmentCount: number;
  /** False when only orphan fragments were seen and no complete source is known. */
  downloadable: boolean;
}

export interface MediaCandidateOptions {
  pageTitle?: string;
  pageUrl?: string;
  /** Localized fallback supplied by the caller. */
  fallbackTitle: string;
  /** Localized label used when multiple candidates share one page title. */
  videoLabel?: string;
  manifests?: DashManifestEntry[];
  /** URL 去重键（调用方传入 `engine.dedupeKey` 的闭包）。 */
  key: (url: string) => string;
}

/**
 * 仅用于判断同一媒体轨道是否因签名/鉴权参数变化而重复出现。
 *
 * 不能直接把所有查询参数都从下载 URL 中删除：某些站点会用 itag、quality
 * 等参数区分不同清晰度。这里保留原始 URL 用于下载，只在候选身份判断时使用
 * origin + pathname；清晰度、码率、编码和 representation id 会在 trackIdentity
 * 中继续区分真正不同的轨道。
 */
function stableMediaPath(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * 返回不含 Origin、查询参数和 hash 的媒体路径。
 *
 * 同一媒体的备用 CDN 常常只替换域名，分片路径和文件名保持不变；这
 * 个键只用于把分片关联到已经解析出的清单，不用于生成下载 URL 或跨
 * 媒体去重。
 */
function mediaPathKey(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return pathname || "/";
  } catch {
    return url;
  }
}

/** 用于识别“清单 URL 就是当前页面”的强关联。 */
function pagePathKey(url: string | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${pathname || "/"}`;
  } catch {
    return "";
  }
}

function isFragmentUrl(url: string): boolean {
  const ext = extractExtension(url);
  return ext === "m4s" || ext === "ts";
}

function isManifestUrl(url: string, mimeType?: string): boolean {
  if (isStreamingUrl(url) && !isFragmentUrl(url)) return true;
  const mime = mimeType?.toLowerCase().split(";", 1)[0].trim();
  return mime === "application/vnd.apple.mpegurl" ||
    mime === "application/x-mpegurl" ||
    mime === "application/mpegurl" ||
    mime === "application/octet-stream-m3u8" ||
    mime === "application/dash+xml";
}

function isCompleteFragmentResource(resource: DetectedResource): boolean {
  if (!isFragmentUrl(resource.url)) return false;
  // tab-state 入库时会用 URL 基名补全 filename，所以 filename 非空并不代表服务器
  // 给了 Content-Disposition 文件名；只有与 URL 基名不同的名字才算显式信号。
  // 无显式名字的媒体，超大响应也不是普通 MSE 分片。
  const filename = resource.filename?.trim();
  const explicitName =
    Boolean(filename) &&
    filename !== extractFilenameFromUrl(resource.url) &&
    filename !== extractFilenameFromUrl(resource.finalUrl ?? "");
  return Boolean(resource.isAttachment || explicitName) || resource.size >= 16 * 1024 * 1024;
}

function isCompleteVideoResource(resource: DetectedResource): boolean {
  if (isFragmentUrl(resource.url) && !isCompleteFragmentResource(resource)) return false;
  if (isManifestUrl(resource.url, resource.mimeType)) return false;
  if (resource.type === "audio") return false;
  if (resource.type === "video") return true;
  const mime = resource.mimeType?.toLowerCase() || "";
  const ext = extractExtension(resource.url);
  return mime.startsWith("video/") || ["mp4", "webm", "mov", "mkv", "avi"].includes(ext);
}

/** 在已有权威 manifest 时，把本 tab 的分片作为其证据，不再暴露为独立下载项。 */
function fragmentFamilyKey(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const slash = pathname.lastIndexOf("/");
    const directory = slash > 0 ? pathname.slice(0, slash) : "/";
    return `${parsed.origin}${directory}/<fragments>`;
  } catch {
    return url;
  }
}

interface UrlPathInfo {
  origin: string;
  directory: string;
}

function urlPathInfo(url: string): UrlPathInfo | null {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const slash = pathname.lastIndexOf("/");
    return {
      origin: parsed.origin,
      directory: slash > 0 ? pathname.slice(0, slash) : "/",
    };
  } catch {
    return null;
  }
}

/**
 * 播放器常把 Representation 的 BaseURL 放在目录上层，再把实际分片放到
 * 子目录；也有 CDN 会在重定向后改变签名参数。目录前缀匹配比“父目录必须
 * 完全相同”更适合这种通用 DASH 结构，但只在同一 origin 内启用。
 */
function relatedFragmentPath(
  track: UrlPathInfo | null,
  resource: UrlPathInfo | null,
): boolean {
  if (!track || !resource || track.origin !== resource.origin) return false;
  if (track.directory === "/" || resource.directory === "/") return false;
  return track.directory === resource.directory
    || track.directory.startsWith(`${resource.directory}/`)
    || resource.directory.startsWith(`${track.directory}/`);
}

function cleanTitle(raw: string | undefined, fallback: string): string {
  const title = (raw || "").replace(/\s+/g, " ").trim();
  if (title) return title.slice(0, 160);
  return fallback.trim() || "Video";
}

function qualityLabel(height?: number, bandwidth?: number): string {
  if (height && height > 0) return `${height}p`;
  if (bandwidth && bandwidth > 0) return `${Math.round(bandwidth / 1000)}kbps`;
  return "unknown";
}

function shortCodec(codecs?: string): string | undefined {
  if (!codecs) return undefined;
  return codecs.split(".")[0];
}

function periodKey(track: DashManifest["video"][number]): string {
  return track.periodId || "__default__";
}

function bestAudioUrl(audio: DashManifest["audio"]): string | undefined {
  return audio.filter((track) => track.downloadable !== false).reduce<string | undefined>((best, track) => {
    if (!best) return track.url;
    const current = audio.find((item) => item.url === best);
    return (track.bandwidth ?? 0) > (current?.bandwidth ?? 0)
      ? track.url
      : best;
  }, undefined);
}

function trackIdentity(
  track: DashManifest["video"][number],
  kind: "video" | "audio",
): string {
  return [
    kind,
    track.periodId || "",
    stableMediaPath(track.url),
    track.mimeType?.toLowerCase() || "",
    track.codecs?.toLowerCase() || "",
    track.width ?? 0,
    track.height ?? 0,
    track.bandwidth ?? 0,
    track.frameRate ?? 0,
  ].join("|");
}

/** 将同一分辨率、同一帧率的不同编码合并为一个用户可选择的画质档。 */
export function selectQualityVideoTracks(
  tracks: DashManifest["video"],
): DashManifest["video"] {
  const selected = new Map<string, DashManifest["video"][number]>();
  for (const track of tracks) {
    if (track.downloadable === false) continue;
    const height = track.height ?? 0;
    const frameRateKey = track.frameRate && track.frameRate > 0
      ? String(Math.round(track.frameRate))
      : "unknown";
    const qualityKey = height > 0
      ? `height:${height}`
      : `bandwidth:${track.bandwidth ?? 0}`;
    const key = `${periodKey(track)}|${qualityKey}|${frameRateKey}`;
    const current = selected.get(key);
    if (!current || (track.bandwidth ?? 0) > (current.bandwidth ?? 0)) {
      selected.set(key, track);
    }
  }
  return Array.from(selected.values());
}

export function qualityResolutionLabel(label: string): string | undefined {
  const normalized = label.trim().toLowerCase();
  const match = /^(\d+)p$/.exec(normalized);
  return match ? `${Number(match[1])}P` : undefined;
}

export function qualityFrameRateLabel(frameRate?: number): string | undefined {
  if (!frameRate || !Number.isFinite(frameRate) || frameRate <= 0) return undefined;
  return `${Math.round(frameRate)}FPS`;
}

function manifestSignature(manifest: DashManifest): string {
  return [
    ...manifest.video.map((track) => trackIdentity(track, "video")),
    ...manifest.audio.map((track) => trackIdentity(track, "audio")),
  ].sort().join("\n");
}

function manifestPeriods(manifest: DashManifest): Array<{
  key: string;
  video: DashManifest["video"];
  audio: DashManifest["audio"];
}> {
  const audioByPeriod = new Map<string, DashManifest["audio"]>();
  for (const track of manifest.audio) {
    const group = audioByPeriod.get(periodKey(track)) || [];
    group.push(track);
    audioByPeriod.set(periodKey(track), group);
  }
  const videoByPeriod = new Map<string, DashManifest["video"]>();
  for (const track of manifest.video) {
    const group = videoByPeriod.get(periodKey(track)) || [];
    group.push(track);
    videoByPeriod.set(periodKey(track), group);
  }
  return Array.from(videoByPeriod, ([key, video]) => ({
    key,
    video,
    audio: audioByPeriod.get(key) || [],
  }));
}

function relatedManifestResources(
  urlKey: (url: string) => string,
  resources: DetectedResource[],
  manifestUrl: string,
  manifest: DashManifest,
  allowBroadFragmentMatch: boolean,
): DetectedResource[] {
  const trackUrlKeys = new Set<string>();
  const trackPathKeys = new Set<string>();
  const trackMediaPathKeys = new Set<string>();
  const fragmentFamilies = new Set<string>();
  for (const track of [...manifest.video, ...manifest.audio]) {
    trackUrlKeys.add(urlKey(track.url));
    trackPathKeys.add(stableMediaPath(track.url));
    trackMediaPathKeys.add(mediaPathKey(track.url));
    fragmentFamilies.add(fragmentFamilyKey(track.url));
  }
  if (manifestUrl) {
    trackUrlKeys.add(urlKey(manifestUrl));
    trackPathKeys.add(stableMediaPath(manifestUrl));
  }

  const trackUrls = [...manifest.video, ...manifest.audio].map((track) => track.url);
  const trackPathInfos = trackUrls.map(urlPathInfo);
  const manifestOrigins = new Set(
    [manifestUrl, ...trackUrls]
      .map((url) => urlPathInfo(url)?.origin)
      .filter((origin): origin is string => !!origin),
  );

  return resources.filter(
    (resource) => {
      if (
        resource.type !== "video" &&
        resource.type !== "audio" &&
        resource.type !== "stream"
      ) {
        return false;
      }
      if (isCompleteFragmentResource(resource)) return false;
      if (
        trackUrlKeys.has(urlKey(resource.url)) ||
        trackPathKeys.has(stableMediaPath(resource.url))
      ) {
        return true;
      }
      if (!isFragmentUrl(resource.url) || isCompleteFragmentResource(resource)) return false;

      const resourceUrls = [resource.url, resource.finalUrl].filter(
        (url): url is string => !!url,
      );
      // CDN 备用域名可能不出现在当前清单的 BaseURL 中，但同一轨道的
      // pathname 和文件名仍然一致。Bilibili 等站点会同时请求这种镜像
      // 地址；它们应归入清单候选，而不是被误报为“无播放清单”。
      if (resourceUrls.some((resourceUrl) =>
        trackMediaPathKeys.has(mediaPathKey(resourceUrl)))) {
        return true;
      }
      if (resourceUrls.some((resourceUrl) => {
        const resourcePathInfo = urlPathInfo(resourceUrl);
        return fragmentFamilies.has(fragmentFamilyKey(resourceUrl)) ||
          trackPathInfos.some((trackPathInfo) => relatedFragmentPath(trackPathInfo, resourcePathInfo));
      })) {
        return true;
      }

      // 单清单页面通常只有一个播放器。此时即使 CDN 将不同 Representation
      // 放到不同目录，也应把同 origin 的分片归入这个清单；多个清单时保持
      // 保守匹配，避免把广告/第二个播放器的分片错误合并。
      return allowBroadFragmentMatch && resourceUrls.some((resourceUrl) =>
        manifestOrigins.has(urlPathInfo(resourceUrl)?.origin || ""),
      );
    },
  );
}

function directVariant(resource: DetectedResource, index: number): MediaCandidateVariant {
  return {
    id: `direct:${resource.id}:${index}`,
    label: resource.quality || "original",
    videoUrl: resource.url,
    mimeType: resource.mimeType,
    fileSize: resource.size > 0 ? resource.size : undefined,
    resourceId: resource.id,
  };
}

/**
 * 从一 tab 的原始资源和可选 DASH manifest 构建候选列表。
 *
 * 重要约束：只有完整直链或 manifest 才生成可下载 variant；孤立分片只保留
 * 为内部诊断/去重用的一条汇总记录，不在资源列表中刷出大量不可下载卡片。
 */
export function buildMediaCandidates(
  resources: DetectedResource[],
  options: MediaCandidateOptions,
): MediaCandidate[] {
  const urlKey = options.key;
  const mediaResources = resources.filter(
    (resource) =>
      resource.type === "video" ||
      resource.type === "audio" ||
      resource.type === "stream",
  );
  if (mediaResources.length === 0 && !(options.manifests?.length ?? 0)) return [];

  const baseTitle = cleanTitle(options.pageTitle, options.fallbackTitle);
  const usedResourceIds = new Set<string>();
  const candidates: MediaCandidate[] = [];
  const seenManifestUrls = new Set<string>();

  // Map replacement deliberately keeps the newest manifest. CDN signatures and
  // track URLs are often short-lived; retaining the first copy would dedupe the
  // row but leave the user with an expired download URL.
  const latestByManifestUrl = new Map<string, {
    entry: DashManifestEntry;
    manifestIndex: number;
    signature: string;
  }>();
  for (const [manifestIndex, entry] of (options.manifests || []).entries()) {
    const normalizedManifest = normalizeDashManifest(entry?.manifest);
    if (!entry || !normalizedManifest) continue;
    const normalizedEntry = { ...entry, manifest: normalizedManifest };
    const manifestKey = entry.url ? urlKey(entry.url) : "__legacy__";
    latestByManifestUrl.set(manifestKey, {
      entry: normalizedEntry,
      manifestIndex,
      signature: manifestSignature(normalizedManifest),
    });
  }

  const latestBySignature = new Map<string, {
    entry: DashManifestEntry;
    manifestIndex: number;
    manifestKey: string;
  }>();
  for (const [manifestKey, item] of latestByManifestUrl) {
    latestBySignature.set(item.signature, {
      entry: item.entry,
      manifestIndex: item.manifestIndex,
      manifestKey,
    });
  }

  const manifestItems = Array.from(latestBySignature.values());
  const currentPagePath = pagePathKey(options.pageUrl);
  const pageManifests = currentPagePath
    ? manifestItems.filter((item) => pagePathKey(item.entry.url) === currentPagePath)
    : [];
  // 页面内嵌清单的 URL 通常就是当前页面 URL。若存在这种强关联，只保留
  // 同页面的清单，避免播放器预加载的另一个视频因共用页面标题而出现在
  // 资源列表中；若没有强关联，则维持多播放器页面的兼容行为。
  const selectedManifestItems = pageManifests.length > 0
    ? pageManifests
    : manifestItems;
  const ignoredManifestItems = pageManifests.length > 0
    ? manifestItems.filter((item) => !pageManifests.includes(item))
    : [];

  for (const { entry, manifestIndex, manifestKey } of selectedManifestItems) {
    const root = entry.url
      ? mediaResources.find((resource) => urlKey(resource.url) === urlKey(entry.url))
      : undefined;
    const related = entry.url
      ? relatedManifestResources(
        urlKey,
        mediaResources,
        entry.url,
        entry.manifest,
        latestBySignature.size === 1,
      )
        .filter((resource) => !usedResourceIds.has(resource.id))
      : mediaResources.filter(
        (resource) =>
          !usedResourceIds.has(resource.id),
      );
    const periodCandidates = manifestPeriods(entry.manifest);
    const periodRows: MediaCandidate[] = [];
    for (const period of periodCandidates) {
      const audioUrl = bestAudioUrl(period.audio);
      const seenVariantKeys = new Set<string>();
      const variants = selectQualityVideoTracks(period.video).flatMap((track, trackIndex) => {
        // Signed URLs can change between two identical manifest responses. Use
        // the stable track identity for the row key so the same quality is not
        // shown again just because its CDN signature rotated.
        const trackKey = trackIdentity(track, "video");
        if (seenVariantKeys.has(trackKey)) return [];
        seenVariantKeys.add(trackKey);
        return [{
          id: `dash:${manifestIndex}:${period.key}:${track.id ?? trackIndex}:${trackKey}`,
          label: qualityLabel(track.height, track.bandwidth),
          videoUrl: track.url,
          audioUrl,
          mimeType: track.mimeType,
          bandwidth: track.bandwidth,
          codec: shortCodec(track.codecs),
          frameRate: track.frameRate,
        }];
      });
      if (variants.length === 0) continue;
      // rawResourceIds/fragmentCount 归第一条【实际 push 成功】的 periodRow，
      // 而不是按 manifest 里的下标（periodIndex===0）。排在前面的 Period 可能
      // 因 `variants.length===0` 被跳过（如 SSAI 广告 Period 只有 SegmentTemplate
      // 占位、无完整轨道 URL），此时用下标判断会让存活候选拿到空
      // rawResourceIds，而相关资源仍被下方 usedResourceIds 消费——结果是它们
      // 既不在候选里也不在原始资源列表里，凭空消失一次；等下一轮渲染又会
      // 因为 usedResourceIds 未命中而作为独立音频/分片行重新冒出，角标数跳变。
      const isFirstSurvivingPeriod = periodRows.length === 0;
      periodRows.push({
        id: `dash:${manifestKey}:${period.key}`,
        title: baseTitle,
        type: "stream",
        source: "dash",
        pageUrl: options.pageUrl || root?.pageUrl || "",
        variants,
        rawResourceIds: isFirstSurvivingPeriod
          ? Array.from(new Set(related.map((resource) => resource.id)))
          : [],
        fragmentCount: isFirstSurvivingPeriod
          ? related.filter((resource) => isFragmentUrl(resource.url) && !isCompleteFragmentResource(resource)).length
          : 0,
        downloadable: true,
      });
    }

    // A parsed SegmentTemplate/SegmentList has no complete track URL. Leave the
    // original manifest resource available so the engine can handle it itself.
    if (periodRows.length === 0) continue;
    seenManifestUrls.add(manifestKey);
    for (const resource of related) usedResourceIds.add(resource.id);
    if (root) usedResourceIds.add(root.id);
    candidates.push(...periodRows);
  }

  // 被当前页面强关联清单淘汰的预加载媒体仍然是已识别资源，不能掉进
  // fragments:unresolved，也不能作为音频/视频原始资源再次展示。保留一
  // 条不可下载的内部候选，既消费其原始资源，也让调试日志保留关联关系。
  for (const { entry, manifestKey } of ignoredManifestItems) {
    const related = relatedManifestResources(
      urlKey,
      mediaResources,
      entry.url,
      entry.manifest,
      true,
    );
    for (const resource of related) usedResourceIds.add(resource.id);
    if (related.length === 0) continue;
    candidates.push({
      id: `ignored:${manifestKey}`,
      title: baseTitle,
      type: "stream",
      source: "ignored",
      pageUrl: options.pageUrl || related[0]?.pageUrl || "",
      variants: [],
      rawResourceIds: Array.from(new Set(related.map((resource) => resource.id))),
      fragmentCount: related.filter((resource) =>
        isFragmentUrl(resource.url) && !isCompleteFragmentResource(resource),
      ).length,
      downloadable: false,
    });
  }

  // Manifest URLs not parsed as DASH are still valid complete HLS/DASH sources.
  for (const resource of mediaResources) {
    if (
      usedResourceIds.has(resource.id) ||
      !isManifestUrl(resource.url, resource.mimeType) ||
      seenManifestUrls.has(urlKey(resource.url))
    ) {
      continue;
    }
    usedResourceIds.add(resource.id);
    const mime = resource.mimeType?.toLowerCase() || "";
    const source: MediaCandidateSource = extractExtension(resource.url) === "m3u8" ||
      mime.includes("mpegurl")
      ? "hls"
      : "dash";
    candidates.push({
      id: `${source}:${urlKey(resource.url)}`,
      title: baseTitle,
      type: "stream",
      source,
      pageUrl: options.pageUrl || resource.pageUrl,
      variants: [{
        id: `${source}:${resource.id}`,
        label: "auto",
        videoUrl: resource.url,
        mimeType: resource.mimeType,
        fileSize: resource.size > 0 ? resource.size : undefined,
        resourceId: resource.id,
      }],
      rawResourceIds: [resource.id],
      fragmentCount: 0,
      downloadable: true,
    });
  }

  // A normal direct video URL is already a complete candidate.
  const directResources = mediaResources.filter(
    (resource) =>
      !usedResourceIds.has(resource.id) &&
      isCompleteVideoResource(resource),
  );
  for (const [index, resource] of directResources.entries()) {
    usedResourceIds.add(resource.id);
    candidates.push({
      id: `direct:${resource.id}`,
      title: baseTitle,
      type: "video",
      source: "direct",
      pageUrl: options.pageUrl || resource.pageUrl,
      variants: [directVariant(resource, index)],
      rawResourceIds: [resource.id],
      fragmentCount: 0,
      downloadable: true,
    });
  }

  // Keep orphan fragments as one internal summary. The popup and page panel only
  // render downloadable candidates, while raw media IDs are still consumed so
  // audio/m4s/ts requests do not reappear as ordinary resource rows.
  const orphanGroups = new Map<string, DetectedResource[]>();
  for (const resource of mediaResources) {
    if (usedResourceIds.has(resource.id) || !isFragmentUrl(resource.url) || isCompleteFragmentResource(resource)) continue;
    const key = fragmentFamilyKey(resource.url);
    const group = orphanGroups.get(key) || [];
    group.push(resource);
    orphanGroups.set(key, group);
  }
  if (orphanGroups.size > 0) {
    const group = Array.from(orphanGroups.values()).flat();
    candidates.push({
      id: "fragments:unresolved",
      title: baseTitle,
      type: "stream",
      source: "fragments",
      pageUrl: options.pageUrl || group[0]?.pageUrl || "",
      variants: [],
      rawResourceIds: group.map((resource) => resource.id),
      fragmentCount: group.length,
      downloadable: false,
    });
  }

  const downloadableTitles = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.downloadable) {
      downloadableTitles.set(candidate.title, (downloadableTitles.get(candidate.title) || 0) + 1);
    }
  }
  const seenTitles = new Map<string, number>();
  return candidates.map((candidate) => {
    if (!candidate.downloadable || (downloadableTitles.get(candidate.title) || 0) < 2) {
      return candidate;
    }
    const occurrence = (seenTitles.get(candidate.title) || 0) + 1;
    seenTitles.set(candidate.title, occurrence);
    const label = options.videoLabel || "Video";
    return { ...candidate, title: `${candidate.title} · ${label} ${occurrence}` };
  });
}

function safeFilenamePart(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "video";
}

function variantExtension(variant: MediaCandidateVariant): string {
  if (variant.audioUrl) return "mp4";
  const ext = extractExtension(variant.videoUrl);
  // .m3u8 auto 候选走引擎的 HLS 下载器，产物就是 .ts 分片拼接，扩展名 ts 准确。
  // .mpd auto 候选走引擎 DASH 下载器：下载完音视频轨后 ffmpeg mux 成 mp4
  // 容器，再 rename 回原文件名（dash_downloader.rs run_dash_download_inner /
  // mux_audio_video）——若扩展名仍是 ts，用户会拿到一个 .ts 后缀的 MP4 文件。
  if (ext === "m3u8") return "ts";
  if (ext === "mpd") return "mp4";
  if (ext === "m4s" || ext === "ts" || !ext) return "mp4";
  return ext;
}

/**
 * 生成可读且不会把 CDN 分片名暴露给用户的默认任务文件名。
 *
 * 同一候选有多档清晰度可选时（本 PR 的核心交付：每档清晰度独立一行 +
 * 可多选批量下载），把 `variant.label`（`1080p`/`5000kbps` 等稳定标识）
 * 拼进文件名——否则两档默认文件名完全相同，用户下载后无从分辨哪个是
 * 哪个（引擎侧 dedup 只会追加 `(1)`，不解决可读性问题）。单档候选
 * （直链/HLS/DASH auto 等）行为不变。
 */
export function candidateFilename(
  candidate: MediaCandidate,
  variant: MediaCandidateVariant,
): string {
  const base = safeFilenamePart(candidate.title);
  const name = candidate.variants.length > 1
    ? `${base} ${safeFilenamePart(variant.label)}`
    : base;
  return `${name}.${variantExtension(variant)}`;
}

export function defaultCandidateVariant(
  candidate: MediaCandidate,
): MediaCandidateVariant | undefined {
  return candidate.variants[0];
}

/**
 * 候选是否应在面板/弹窗中占一行。
 *
 * - 可下载候选总是可见。
 * - 被当前页面强关联清单淘汰的预加载媒体（`source: "ignored"`）永不可见。
 * - 无法解析出清单的孤立分片汇总（`source: "fragments"`，如 MSE 站点未捕获
 *   到 manifest）只在整页**没有任何可下载候选**时以一条禁用行展示（checkbox
 *   禁用 + `panel.videoNeedsManifest` 提示），否则用户会看到面板/角标显示零
 *   资源，即便页面明明嗅探到了媒体请求；页面已有可下载候选时它只是噪声
 *   （广告/预加载的零散分片），保持隐藏。
 */
export function isMediaCandidateVisible(
  candidate: MediaCandidate,
  candidates: readonly MediaCandidate[],
): boolean {
  if (candidate.downloadable) return true;
  if (candidate.source !== "fragments") return false;
  return !candidates.some((other) => other.downloadable);
}

/** 返回候选在资源面板中占用的行数：可下载候选按清晰度/轨道各占一行，
 *  可见的不可下载汇总占 1 行（可见性规则见 [`isMediaCandidateVisible`]）。 */
export function countMediaCandidateRows(candidates: MediaCandidate[]): number {
  return candidates.reduce((count, candidate) => {
    if (!isMediaCandidateVisible(candidate, candidates)) return count;
    return count + (candidate.downloadable ? Math.max(candidate.variants.length, 1) : 1);
  }, 0);
}
