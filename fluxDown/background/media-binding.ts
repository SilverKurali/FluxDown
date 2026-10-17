/**
 * 媒体候选 ↔ 页面媒体元素的绑定（纯函数，无 DOM / browser 依赖）。
 *
 * 依据 MAIN world 钩子对 `SourceBuffer.appendBuffer` 的来源追踪：
 * - exact：数据 buffer 带着来源 URL 标记（fetch / XHR 响应 → append）；
 * - temporal：没有标记时，append 前 3 s 内完成的媒体响应计数。
 */
import { trackFileKey, type MediaCandidate } from "@/utils/media-candidates";
import type { ElementState } from "./protocol";

export interface CandidateBinding {
  elementKey: string;
  playingVariantId: string | null;
  /**
   * exact：追加的数据带来源标记；temporal：按时间窗口归因；inferred：元素没有任何来源证据
   * （播放器在 Worker 里取数据 / MSE in Worker），按「唯一正在播放的元素 ↔ 唯一可下载候选」推断。
   */
  confidence: "exact" | "temporal" | "inferred";
}

/** 元素优先级：播放且大半可见 3；播放 2；可见且尺寸够大 1；其余 0。 */
export function rankElement(e: ElementState): number {
  if (e.playing && e.visibleRatio >= 0.5) return 3;
  if (e.playing) return 2;
  if (e.visibleRatio > 0 && e.rect.w >= 120 && e.rect.h >= 80) return 1;
  return 0;
}

/** 当前「正在看」的元素：rank 最高且 ≥ 1；同 rank 依次比最近播放、最近交互、面积。 */
export function activeElement(es: ElementState[]): ElementState | null {
  let best: ElementState | null = null;
  for (const e of es) {
    if (rankElement(e) < 1) continue;
    if (!best || compareElements(e, best) > 0) best = e;
  }
  return best;
}

/** > 0 表示 a 比 b 更应被选为当前元素。 */
function compareElements(a: ElementState, b: ElementState): number {
  return (
    rankElement(a) - rankElement(b) ||
    a.lastPlayedAt - b.lastPlayedAt ||
    a.lastInteractionAt - b.lastInteractionAt ||
    a.rect.w * a.rect.h - b.rect.w * b.rect.h
  );
}

interface ElementEvidence {
  exact: Set<string>;
  temporal: Map<string, number>;
}

function evidenceOf(e: ElementState, key: (u: string) => string): ElementEvidence {
  const exact = new Set<string>();
  const temporal = new Map<string, number>();
  for (const sb of e.bindings) {
    for (const url of sb.exact) exact.add(key(url));
    for (const t of sb.temporal) {
      const k = key(t.url);
      temporal.set(k, (temporal.get(k) ?? 0) + t.count);
    }
  }
  // 元素自身的 http(s) currentSrc（直链播放）视为 exact。
  if (e.currentSrc) exact.add(key(e.currentSrc));
  return { exact, temporal };
}

/** 变体关联播放元素可用的视频轨 URL：下载用的轨 + 同档被合并掉的其它编码轨。 */
function variantVideoUrls(v: MediaCandidate["variants"][number]): string[] {
  return [v.videoUrl, ...(v.alternateUrls ?? [])];
}

function candidateUrlKeys(c: MediaCandidate, key: (u: string) => string): Set<string> {
  const keys = new Set<string>(c.rawResourceIds);
  for (const v of c.variants) {
    for (const url of variantVideoUrls(v)) keys.add(key(url));
    if (v.audioUrl) keys.add(key(v.audioUrl));
  }
  return keys;
}

/**
 * 元素正在播放的档位。先按完整 URL 键精确匹配；再按轨道文件身份（`trackFileKey`）匹配，
 * 因为播放器常从与清单 BaseURL 不同的 CDN 镜像取同一文件（B 站 upos / mcdn 互换域名）；
 * 都没有时取 temporal 计数最高的档。
 */
function playingVariant(
  c: MediaCandidate,
  evidence: ElementEvidence,
  key: (u: string) => string,
): string | null {
  const exactFiles = new Set([...evidence.exact].map(trackFileKey));
  for (const v of c.variants) {
    if (variantVideoUrls(v).some((url) => evidence.exact.has(key(url)))) return v.id;
  }
  for (const v of c.variants) {
    if (variantVideoUrls(v).some((url) => exactFiles.has(trackFileKey(url)))) return v.id;
  }
  const temporalFiles = new Map<string, number>();
  for (const [url, count] of evidence.temporal) {
    const file = trackFileKey(url);
    temporalFiles.set(file, (temporalFiles.get(file) ?? 0) + count);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const v of c.variants) {
    const count = variantVideoUrls(v).reduce((sum, url) => sum + (temporalFiles.get(trackFileKey(url)) ?? 0), 0);
    if (count > bestCount) {
      bestCount = count;
      best = v.id;
    }
  }
  return best;
}

/**
 * 把候选绑定到元素：score = 10 × |S ∩ E| + Σ T[s]（s ∈ S）；取 score > 0 且最高者，
 * 同分取 rankElement 更高的元素；任一 E 命中则 confidence 为 exact。
 */
export function bindCandidates(
  cands: MediaCandidate[],
  es: ElementState[],
  key: (u: string) => string,
): Map<string, CandidateBinding> {
  const evidences = es.map((e) => ({ e, ev: evidenceOf(e, key) }));
  const result = new Map<string, CandidateBinding>();
  const scores = new Map<string, number>();

  for (const c of cands) {
    const s = candidateUrlKeys(c, key);
    let best: { e: ElementState; ev: ElementEvidence; score: number; hits: number } | null = null;
    for (const { e, ev } of evidences) {
      let hits = 0;
      let temporalSum = 0;
      for (const k of s) {
        if (ev.exact.has(k)) hits++;
        temporalSum += ev.temporal.get(k) ?? 0;
      }
      const score = 10 * hits + temporalSum;
      if (score <= 0) continue;
      if (!best || score > best.score || (score === best.score && rankElement(e) > rankElement(best.e))) {
        best = { e, ev, score, hits };
      }
    }
    if (!best) continue;
    result.set(c.id, {
      elementKey: best.e.key,
      playingVariantId: playingVariant(c, best.ev, key),
      confidence: best.hits > 0 ? "exact" : "temporal",
    });
    scores.set(c.id, best.score);
  }

  // 弱证据修剪：元素已有 exact 绑定的候选时，丢弃它的 temporal 绑定；
  // 只有 temporal 时，每个元素只保留得分最高的家族（预加载的下一个视频计数更低）。
  const exactElements = new Set<string>();
  for (const b of result.values()) if (b.confidence === "exact") exactElements.add(b.elementKey);
  const bestTemporal = new Map<string, number>();
  for (const [id, b] of result) {
    if (b.confidence !== "temporal") continue;
    const score = scores.get(id) ?? 0;
    bestTemporal.set(b.elementKey, Math.max(bestTemporal.get(b.elementKey) ?? 0, score));
  }
  for (const [id, b] of [...result]) {
    if (b.confidence !== "temporal") continue;
    if (exactElements.has(b.elementKey) || (scores.get(id) ?? 0) < (bestTemporal.get(b.elementKey) ?? 0)) {
      result.delete(id);
    }
  }
  return result;
}
