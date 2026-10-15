/**
 * 资源入库策略：分类型大小阈值、置信度与「是否值得展示」。
 *
 * 噪音 / API 判断由规则引擎（`builtin.noise.*`）负责，blob/data 过滤在入库前完成；
 * 这里只保留大小与置信度逻辑。
 */
import type {
  ConfidenceLevel,
  DetectedResource,
  DetectionMethod,
  ResourceType,
} from "@/utils/resource-types";

/** 分类型最低大小阈值（字节），-1 表示不限。低于阈值的资源被认为是噪音（预加载片段、缩略图等）。 */
export const SIZE_THRESHOLDS: Record<ResourceType, number> = {
  video: 500 * 1024,
  audio: 100 * 1024,
  document: -1,
  archive: -1,
  image: 100 * 1024,
  executable: -1,
  torrent: -1,
  stream: -1,
  subtitle: -1,
  magnet: -1,
  other: 50 * 1024,
};

/**
 * 根据资源属性计算可信度：
 * - high：attachment、stream manifest、torrent/executable/subtitle/magnet、已知类型且超过阈值；
 * - medium：已知类型但大小未知、图片超过阈值、> 1MB 的未知类型；
 * - low：小文件与其余。
 */
export function computeConfidence(
  type: ResourceType,
  size: number,
  _detectedBy: DetectionMethod,
  isAttachment?: boolean,
): ConfidenceLevel {
  if (isAttachment) return "high";
  if (type === "stream") return "high";
  if (type === "torrent" || type === "executable" || type === "subtitle" || type === "magnet") {
    return "high";
  }

  const threshold = SIZE_THRESHOLDS[type];
  if (type !== "other" && type !== "image") {
    if (size > 0 && threshold > 0 && size >= threshold) return "high";
    if (size <= 0) return "medium"; // 大小未知，但类型明确
    return "low";
  }

  if (type === "image") {
    if (size > 0 && size >= (threshold > 0 ? threshold : 100 * 1024)) return "medium";
    return "low";
  }

  if (size > 0 && size >= 1024 * 1024) return "medium";
  return "low";
}

/** 判断资源是否值得展示：分类型大小阈值（attachment 豁免）与小图标过滤。 */
export function isWorthShowing(resource: DetectedResource): boolean {
  if (resource.type === "magnet") return true;

  if (resource.size > 0) {
    const threshold = SIZE_THRESHOLDS[resource.type];
    if (threshold > 0 && resource.size < threshold && !resource.isAttachment) {
      return false;
    }
  }

  // 图片：< 10KB 的明显是小图标。
  if (resource.type === "image" && resource.size > 0 && resource.size < 10 * 1024) {
    return false;
  }

  return true;
}
