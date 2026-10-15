/**
 * MAIN world（page/hooks.ts）与 ISOLATED world（sensor.content.ts）之间的事件契约。
 *
 * 所有 `detail` 一律是 JSON 字符串：Chrome / Firefox 的 world 边界都只能可靠地传递
 * 原始字符串（Firefox 的 Xray 包装会让对象 detail 不可读）。接收方 `try/JSON.parse`，
 * 失败即丢弃。
 */

/** MAIN → ISOLATED，在 document 上派发。 */
export const EV_REPORT = "__fluxdown_report";
/** ISOLATED → MAIN，在 document 上派发。 */
export const EV_CONFIG = "__fluxdown_config";
/** MAIN 在媒体元素上派发（composed: true，bubbles: false）；无元素时在 document 上派发并带 elementless。 */
export const EV_MEDIA = "__fluxdown_media";

export type ReportDetail =
  | { t: "resource"; url: string; mime?: string; size?: number; via: "fetch" | "xhr" }
  | { t: "manifest"; manifestUrl: string; manifest: unknown }
  | { t: "body"; url: string; ruleIds: string[]; text: string }
  | { t: "preempt"; url: string; filename?: string }
  | { t: "pageUrl" };

export interface SourceBufferBinding {
  sbId: number;
  mime: string;
  kind: "video" | "audio" | "unknown";
  /** appendBuffer 的数据按来源打标命中的响应 URL（去重，最近 64 个）。 */
  exact: string[];
  /** 无标记时按时间窗口归因的响应 URL 计数（count 最高的 16 个）。 */
  temporal: { url: string; count: number }[];
}

export interface MediaDetail {
  msId: number;
  sourceBuffers: SourceBufferBinding[];
  /** MediaSource 尚未关联任何元素时为 true（在 document 上派发）。 */
  elementless?: boolean;
}

export interface PageConfig {
  sniff: boolean;
  bodyWatch: { ruleId: string; url?: string[]; host?: string[]; pathRegex?: string }[];
  dom: { ruleId: string; selector: string; attr: string }[];
  floatButton: boolean;
  floatTrigger: "hover" | "always";
  pageDot: boolean;
  frameIsTop: boolean;
  /** 是否接管本页 magnet 链接点击：settings.enabled && settings.interceptMagnet && 站点 intercept !== "never"。 */
  interceptMagnet: boolean;
  /** settings.sniffImages：DOM 扫描是否把图片链接算作可下载。 */
  sniffImages: boolean;
  /** SPA 导航代数：sensor 每次导航递增，MAIN 侧据此重置去重状态。 */
  epoch?: number;
}

/** 编码 detail；接收方用 {@link decodeDetail}。 */
export function encodeDetail(value: ReportDetail | MediaDetail | PageConfig): string {
  return JSON.stringify(value);
}

/** 解码 CustomEvent.detail；非字符串或 JSON 失败返回 null。形状由调用方按判别字段检查。 */
export function decodeDetail(detail: unknown): unknown {
  if (typeof detail !== "string") return null;
  try {
    return JSON.parse(detail) as unknown;
  } catch {
    return null;
  }
}
