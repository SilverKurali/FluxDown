/**
 * 规则存储与编译：合并 builtin、本地规则、官方 / 社区包（`fluxdown_rule_packs`）与
 * 覆盖（overrides），编译为 CompiledRules。任一来源变化时重编译并广播 PageConfig 失效。
 *
 * 远程包只经桌面端 agent 下发（agent 负责验签与吊销）；扩展侧再做一次 validatePack。
 */
import { browser } from "wxt/browser";
import { BUILTIN_PACK, compileBuiltin, compileRules } from "@/rules/engine";
import type { CompiledRules } from "@/rules/engine";
import type { RevocationDoc, RuleOverrides, RulePack, SniffRuleV1 } from "@/rules/schema";
import { RULE_ENGINE_VERSION } from "@/rules/schema";
import { validatePack } from "@/rules/validate";
import { fetchSniffRules, getCapabilities } from "./host";
import type { RuleDocSummary, RuleSyncStatus, StoredRulePacks } from "./protocol";
import { getCachedSettings } from "./settings-cache";

export const LOCAL_RULES_KEY = "fluxdown_local_rules";
export const RULE_OVERRIDES_KEY = "fluxdown_rule_overrides";
export const RULE_PACKS_KEY = "fluxdown_rule_packs";
const SYNC_ALARM = "fluxdown-rules-sync";
const SYNC_PERIOD_MIN = 360;
const FIRST_SYNC_DELAY_MS = 5_000;
/** community 包带过期时间；编译快照超过 1 h 就后台重编译一次。 */
const COMPILE_MAX_AGE_MS = 60 * 60 * 1000;

let engine: CompiledRules = compileBuiltin();
let compiledAt = Date.now();
let building: Promise<void> | null = null;
/** 编译期间收到新的重编译请求。 */
let dirty = false;
let hostStatus: RuleSyncStatus["host"] = null;
const changeListeners: Array<() => void> = [];

/** 当前规则引擎（同步可用：未加载完远程包前是仅含 builtin 的引擎）。 */
export function getEngine(): CompiledRules {
  if (Date.now() - compiledAt > COMPILE_MAX_AGE_MS) void rebuildEngine();
  return engine;
}

/** 引擎重编译完成后通知（PageConfig 失效广播、视图刷新）。 */
export function onEngineChanged(listener: () => void): void {
  changeListeners.push(listener);
}

async function loadStored(): Promise<StoredRulePacks> {
  const raw = (await browser.storage.local.get(RULE_PACKS_KEY))[RULE_PACKS_KEY];
  return raw && typeof raw === "object" ? (raw as StoredRulePacks) : {};
}

async function saveStored(stored: StoredRulePacks): Promise<void> {
  await browser.storage.local.set({ [RULE_PACKS_KEY]: stored });
}

function localPack(rules: SniffRuleV1[]): RulePack {
  return {
    format: "fluxdown-sniff-pack",
    packId: "local",
    sequence: 0,
    engine: RULE_ENGINE_VERSION,
    issuedAt: new Date(0).toISOString(),
    rules,
  };
}

async function compileFromStorage(): Promise<CompiledRules> {
  const local = await browser.storage.local.get([LOCAL_RULES_KEY, RULE_OVERRIDES_KEY]);
  const localRules = Array.isArray(local[LOCAL_RULES_KEY])
    ? (local[LOCAL_RULES_KEY] as SniffRuleV1[])
    : [];
  const overrides = (local[RULE_OVERRIDES_KEY] ?? {}) as RuleOverrides;
  const stored = await loadStored();
  const settings = await getCachedSettings();

  const packs: RulePack[] = [BUILTIN_PACK];
  if (stored.official) packs.push(stored.official);
  if (stored.community) packs.push(stored.community);
  if (localRules.length > 0) packs.push(localPack(localRules));

  return compileRules({
    packs,
    overrides,
    revocations: stored.revocations ?? null,
    options: {
      sniffImages: settings.sniffImages,
      communityEnabled: settings.communityRulesEnabled,
      now: Date.now(),
    },
  });
}

/**
 * 重新编译（并发合并为同一次）；完成后通知监听者。
 * 编译期间又来了新的触发时置 `dirty`，本轮结束后再编译一轮，避免读取存储之后才发生的变更被吞掉。
 */
export function rebuildEngine(): Promise<void> {
  if (building) {
    dirty = true;
    return building;
  }
  building = (async () => {
    do {
      dirty = false;
      try {
        engine = await compileFromStorage();
        compiledAt = Date.now();
        for (const listener of changeListeners) listener();
      } catch (e) {
        console.warn("[FluxDown] rule engine rebuild failed:", e);
      }
    } while (dirty);
  })().finally(() => {
    building = null;
  });
  return building;
}

function summarize(doc: { sequence: number; issuedAt: string; expiresAt?: string } | undefined): RuleDocSummary | null {
  return doc ? { sequence: doc.sequence, issuedAt: doc.issuedAt, expiresAt: doc.expiresAt } : null;
}

/** 规则同步状态（options `#rules` 与诊断页展示）。 */
export async function getRuleSyncStatus(): Promise<RuleSyncStatus> {
  const [stored, settings] = await Promise.all([loadStored(), getCachedSettings()]);
  return {
    enabled: settings.ruleSyncEnabled,
    communityEnabled: settings.communityRulesEnabled,
    official: summarize(stored.official),
    community: summarize(stored.community),
    revocations: summarize(stored.revocations),
    lastSyncAt: stored.lastSyncAt ?? null,
    lastError: stored.lastError ?? null,
    host: hostStatus,
  };
}

function isRevocationDoc(value: unknown): value is RevocationDoc {
  if (!value || typeof value !== "object") return false;
  const doc = value as Partial<RevocationDoc>;
  return (
    doc.format === "fluxdown-sniff-revocations" &&
    Number.isInteger(doc.sequence) &&
    Array.isArray(doc.entries)
  );
}

/** 从桌面端拉取规则包。条件：ruleSyncEnabled 且协议 v2。返回最新同步状态。 */
export async function syncRemotePacks(): Promise<RuleSyncStatus> {
  const settings = await getCachedSettings();
  if (!settings.ruleSyncEnabled) return getRuleSyncStatus();
  const caps = await getCapabilities();
  if (caps.protocol !== 2) return getRuleSyncStatus();

  const stored = await loadStored();
  const reply = await fetchSniffRules({
    official: stored.official?.sequence,
    community: stored.community?.sequence,
    revocations: stored.revocations?.sequence,
  });
  if (!reply) {
    await saveStored({ ...stored, lastError: "sniff_rules_unavailable" });
    return getRuleSyncStatus();
  }
  hostStatus = reply.status;

  const next: StoredRulePacks = { ...stored, lastSyncAt: Date.now(), lastError: undefined };
  const problems: string[] = [];
  for (const tier of ["official", "community"] as const) {
    const incoming = reply[tier];
    if (!incoming) continue;
    try {
      const { pack, rejected } = validatePack(incoming, tier);
      const current = stored[tier];
      if (current && pack.sequence < current.sequence) {
        problems.push(`${tier}: rollback`);
        continue;
      }
      next[tier] = pack;
      if (rejected.length > 0) problems.push(`${tier}: ${rejected.length} rule(s) rejected`);
    } catch (e) {
      problems.push(`${tier}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (reply.revocations) {
    if (isRevocationDoc(reply.revocations)) {
      if (!stored.revocations || reply.revocations.sequence >= stored.revocations.sequence) {
        next.revocations = reply.revocations;
      }
    } else {
      problems.push("revocations: invalid");
    }
  }
  next.lastError = problems.length > 0 ? problems.join("; ") : reply.status.lastError ?? undefined;
  await saveStored(next);
  // storage.onChanged 会触发重编译；这里不重复。
  return getRuleSyncStatus();
}

/** 同步注册 storage 监听与 alarm；由 startBackground 调用一次。 */
export function installRulesStore(): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      if (changes[LOCAL_RULES_KEY] || changes[RULE_OVERRIDES_KEY] || changes[RULE_PACKS_KEY]) {
        void rebuildEngine();
      }
    } else if (area === "sync" && changes.settings) {
      // sniffImages / communityRulesEnabled 影响编译结果。
      void rebuildEngine();
    }
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== SYNC_ALARM) return;
    syncRemotePacks().catch((e) => console.warn("[FluxDown] rule sync failed:", e));
  });
  browser.alarms
    .create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MIN })
    .catch(() => {});
  void rebuildEngine();
  setTimeout(() => {
    syncRemotePacks().catch((e) => console.warn("[FluxDown] rule sync failed:", e));
  }, FIRST_SYNC_DELAY_MS);
}
