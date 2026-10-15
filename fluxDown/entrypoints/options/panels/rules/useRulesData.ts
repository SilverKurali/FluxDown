/**
 * 规则面板的数据源：规则列表（rulesList）与规则同步状态（getHostStatus.ruleSync）。
 * 规则相关存储键或设置变化后短暂延迟重取，等 background 重新编译完成。
 */
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { browser } from "wxt/browser";
import type { RuleSyncStatus, RulesListEntry } from "@/background/protocol";
import { sendAction } from "@/utils/messaging";
import { LOCAL_RULES_KEY, RULE_OVERRIDES_KEY } from "../../lib/local-rules";

const RULE_PACKS_KEY = "fluxdown_rule_packs";
const WATCHED_LOCAL_KEYS: Record<string, true> = {
  [LOCAL_RULES_KEY]: true,
  [RULE_OVERRIDES_KEY]: true,
  [RULE_PACKS_KEY]: true,
};
const RELOAD_DELAY_MS = 300;

export interface RulesData {
  entries: RulesListEntry[];
  sync: RuleSyncStatus | null;
  /** 最近一次取数失败的原因；成功后清空。 */
  loadError: string | null;
  setSync: (status: RuleSyncStatus) => void;
  reload: () => void;
}

export function useRulesData(): RulesData {
  const [entries, setEntries] = useState<RulesListEntry[]>([]);
  const [sync, setSync] = useState<RuleSyncStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const reload = useCallback(() => {
    sendAction<"rulesList">({ action: "rulesList" })
      .then((list) => {
        setEntries(list);
        setLoadError(null);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
    sendAction<"getHostStatus">({ action: "getHostStatus" })
      .then((host) => setSync(host.ruleSync))
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    reload();
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      const relevant =
        (area === "local" && Object.keys(changes).some((k) => WATCHED_LOCAL_KEYS[k])) ||
        (area === "sync" && "settings" in changes);
      if (!relevant) return;
      clearTimeout(timer.current);
      timer.current = window.setTimeout(reload, RELOAD_DELAY_MS);
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      clearTimeout(timer.current);
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, [reload]);

  return { entries, sync, loadError, setSync, reload };
}
