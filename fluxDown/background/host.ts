/**
 * 桌面端（NMH → agent）能力探测与协议 v2 请求封装。
 *
 * 协议 1（旧桌面端）：`capabilities` 返回 `unknown action`，此时不做规则同步、
 * 不跟踪 capture、不判断解析插件。远程 always 模式不走 NMH，直接按协议 1 处理。
 */
import type { RevocationDoc, RulePack } from "@/rules/schema";
import {
  checkFluxDownAvailable,
  effectiveRemoteMode,
  isUnreachableFailure,
} from "@/utils/download-dispatch";
import { nmhCall } from "@/utils/native-messaging";
import type { CaptureState } from "./capture-logic";
import type { HostCapabilities, ResolverInfo } from "./protocol";

const CAPABILITIES_TTL_MS = 60_000;
/** 未连接时的结果只缓存很短时间，App 一启动就能被感知。 */
const DISCONNECTED_TTL_MS = 5_000;
/** capture_status 单次请求的 id 数量上限（桌面端同口径）。 */
const CAPTURE_STATUS_MAX_IDS = 256;

export interface SniffRulesHave {
  official?: number;
  community?: number;
  revocations?: number;
}

export interface SniffRulesReply {
  official: RulePack | null;
  community: RulePack | null;
  revocations: RevocationDoc | null;
  status: { lastFetchUnix: number | null; lastError: string | null };
}

interface CapabilitiesData {
  protocol?: number;
  pluginsSupported?: boolean;
  resolvers?: ResolverInfo[];
}

const PROTOCOL_ONE_OFFLINE: HostCapabilities = {
  protocol: 1,
  pluginsSupported: false,
  resolvers: [],
  connected: false,
};

let cached: { value: HostCapabilities; expiresAt: number } | null = null;
let inflight: Promise<HostCapabilities> | null = null;

function isUnknownAction(message: string | undefined): boolean {
  return typeof message === "string" && message.startsWith("unknown action");
}

async function probeCapabilities(): Promise<HostCapabilities> {
  if ((await effectiveRemoteMode()) === "always") {
    const connected = await checkFluxDownAvailable().catch(() => false);
    return { ...PROTOCOL_ONE_OFFLINE, connected };
  }

  const reply = await nmhCall<CapabilitiesData>("capabilities", {});
  if (reply.success) {
    const data = reply.data ?? {};
    return {
      protocol: data.protocol !== undefined && data.protocol >= 2 ? 2 : 1,
      pluginsSupported: data.pluginsSupported === true,
      resolvers: Array.isArray(data.resolvers) ? data.resolvers : [],
      connected: true,
    };
  }
  if (isUnknownAction(reply.message)) {
    // 旧桌面端：已连通，但不认识 v2 动作。
    return { ...PROTOCOL_ONE_OFFLINE, connected: true };
  }
  if (isUnreachableFailure({ success: false, message: reply.message })) {
    return PROTOCOL_ONE_OFFLINE;
  }
  // 桌面端 v2 但 daemon 侧失败（如 plugin.list 报错）：已连接，解析能力未知。
  return { protocol: 2, pluginsSupported: false, resolvers: [], connected: true };
}

/** 取桌面端能力（缓存 60 s；`force` 跳过缓存）。 */
export function getCapabilities(force = false): Promise<HostCapabilities> {
  const now = Date.now();
  if (!force && cached && cached.expiresAt > now) return Promise.resolve(cached.value);
  if (inflight) return inflight;
  inflight = probeCapabilities()
    .catch(() => PROTOCOL_ONE_OFFLINE)
    .then((value) => {
      cached = {
        value,
        expiresAt: Date.now() + (value.connected ? CAPABILITIES_TTL_MS : DISCONNECTED_TTL_MS),
      };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 供 App 已确认可达（ping 成功）时使旧的「未连接」缓存立刻失效。 */
export function invalidateCapabilities(): void {
  cached = null;
}

/** 查询 capture 事务状态；任何失败返回空表（调用方视为「暂无结论」）。 */
export async function captureStatus(ids: string[]): Promise<Record<string, CaptureState>> {
  const out: Record<string, CaptureState> = {};
  for (let i = 0; i < ids.length; i += CAPTURE_STATUS_MAX_IDS) {
    const chunk = ids.slice(i, i + CAPTURE_STATUS_MAX_IDS);
    const reply = await nmhCall<{ statuses?: Record<string, CaptureState> }>("capture_status", {
      transactionIds: chunk,
    });
    if (!reply.success) continue;
    Object.assign(out, reply.data?.statuses ?? {});
  }
  return out;
}

/** 向桌面端拉取规则包增量；失败返回 null。 */
export async function fetchSniffRules(have: SniffRulesHave): Promise<SniffRulesReply | null> {
  const reply = await nmhCall<SniffRulesReply>("sniff_rules", { have });
  if (!reply.success || !reply.data) return null;
  return reply.data;
}
