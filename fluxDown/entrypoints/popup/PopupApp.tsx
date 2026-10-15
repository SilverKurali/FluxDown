/**
 * Popup 根组件（380×560）：头部（连接状态 + 总拦截开关）、站点卡、资源摘要、任务、页脚。
 * 资源/预览逻辑全部由 ui/features 提供；本文件只负责组装与 popup 独有的状态。
 */
import type { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { browser } from "wxt/browser";
import type { TabView } from "@/background/protocol";
import { checkFluxDownAvailable } from "@/utils/download-dispatch";
import { exportConnectionDiagnostics } from "@/utils/connection-diagnostics";
import { loadSettings, saveSettings } from "@/utils/settings";
import { Button } from "@/ui/components/Button";
import { Icon } from "@/ui/components/Icon";
import { IconButton } from "@/ui/components/IconButton";
import { Toggle } from "@/ui/components/Toggle";
import { ToastHost, showToast } from "@/ui/components/Toast";
import { ResourceList } from "@/ui/features/ResourceList";
import { SiteCard } from "@/ui/features/SiteCard";
import { TaskList } from "@/ui/features/TaskList";
import { useSidePanelOpener } from "@/ui/hooks/useSidePanelOpener";
import { useTabView } from "@/ui/hooks/useTabView";
import { useT } from "@/ui/i18n";
import { useThemeAttr } from "@/ui/theme";
import "@/ui/theme/tokens.css";
import "@/ui/theme/base.css";
import "./popup.css";

/** 摘要中除「当前播放」外最多显示的行数。 */
const SUMMARY_EXTRA_ROWS = 5;

type ConnectionState = "checking" | "connected" | "disconnected";

interface DailyStats {
  sent?: number;
  failed?: number;
  date?: string;
}

/**
 * 头部连接状态。探活复用 download-dispatch，与实际下载路由判定一致。
 * 并发守卫：连续触发刷新时只让最后一次的结果落到 UI（epoch 递增，旧结果丢弃）。
 */
function useConnection(): { state: ConnectionState; refresh: () => void } {
  const [state, setState] = useState<ConnectionState>("checking");
  const epochRef = useRef(0);

  const refresh = useCallback(() => {
    const epoch = ++epochRef.current;
    setState("checking");
    checkFluxDownAvailable()
      .catch(() => false)
      .then((available) => {
        if (epoch !== epochRef.current) return;
        setState(available ? "connected" : "disconnected");
        if (available) browser.runtime.sendMessage({ action: "appConfirmedUp" }).catch(() => {});
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { state, refresh };
}

/** 当前窗口活动 tab 的 id；查询不到时为 null。 */
function useActiveTabId(): number | null {
  const [tabId, setTabId] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        if (alive) setTabId(tabs[0]?.id ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return tabId;
}

/** 今日统计；日期不是今天则视为 0（跨天归零由 background/stats 在下次累计时落盘）。 */
function useStats(): { sent: number; failed: number } {
  const [stats, setStats] = useState({ sent: 0, failed: 0 });
  useEffect(() => {
    let alive = true;
    browser.storage.local
      .get("stats")
      .then((r) => {
        const raw = r.stats as DailyStats | undefined;
        if (!alive || !raw || raw.date !== new Date().toDateString()) return;
        setStats({ sent: raw.sent || 0, failed: raw.failed || 0 });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return stats;
}

/** 拦截总开关（settings.enabled）。 */
function useInterceptEnabled(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    let alive = true;
    loadSettings()
      .then((s) => {
        if (alive) setEnabled(s.enabled);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const update = (next: boolean) => {
    setEnabled(next);
    saveSettings({ enabled: next }).catch(() => setEnabled(!next));
  };
  return [enabled, update];
}

/** 资源摘要用的视图：playing 全留，其余候选与文件合计只取前 N 行。 */
function summarize(view: TabView): { summary: TabView; total: number } {
  const total =
    view.playing.length + view.otherElements.length + view.unbound.length + view.files.length;
  let budget = SUMMARY_EXTRA_ROWS;
  const take = <T,>(rows: T[]): T[] => {
    const kept = rows.slice(0, budget);
    budget -= kept.length;
    return kept;
  };
  const otherElements = take(view.otherElements);
  const unbound = take(view.unbound);
  const files = take(view.files);
  return { summary: { ...view, otherElements, unbound, files }, total };
}

export function PopupApp(): JSX.Element {
  useThemeAttr(document.documentElement);
  const t = useT();
  const connection = useConnection();
  const [enabled, setEnabled] = useInterceptEnabled();
  const tabId = useActiveTabId();
  const view = useTabView(tabId).value;
  const stats = useStats();
  const sidePanel = useSidePanelOpener(true);
  const [exporting, setExporting] = useState(false);

  const manifest = browser.runtime.getManifest();
  const version = manifest.version_name ?? `v${manifest.version}`;
  const summary = view ? summarize(view) : null;

  const exportDiagnostics = async () => {
    setExporting(true);
    try {
      await exportConnectionDiagnostics();
      showToast(t("diagnostics.exportStarted"), "success");
    } catch {
      showToast(t("diagnostics.exportFailed"), "error");
    } finally {
      setExporting(false);
    }
  };

  const switchLabel = `${t("switch.label")} · ${enabled ? t("switch.enabled") : t("switch.disabled")}`;

  return (
    <div class="pp-root">
      <header class="pp-header">
        <div class="pp-logo">
          <img src="/icon/fluxdown_logo.png" alt="FluxDown" width={22} height={22} />
          <span class="pp-title">FluxDown</span>
        </div>
        <div class="pp-header-right">
          <button
            type="button"
            class={`pp-status pp-${connection.state}`}
            title={t(`header.${connection.state}`)}
            onClick={connection.refresh}
          >
            <span class="pp-status-dot" />
            <span>{t(`header.${connection.state}`)}</span>
          </button>
          <Toggle checked={enabled} onChange={setEnabled} label={switchLabel} />
        </div>
      </header>

      <main class="pp-content">
        {view ? <SiteCard host={view.site.host} compact /> : null}

        <section class="pp-section">
          <div class="pp-section-head">
            <span>{t("popup.tabs.resources")}</span>
            {summary && summary.total > 0 ? <span class="pp-count">{summary.total}</span> : null}
          </div>
          {summary && summary.total > 0 ? (
            <>
              <ResourceList view={summary.summary} density="compact" showSearch={false} />
              {sidePanel.available ? (
                <Button variant="ghost" size="sm" class="pp-view-all" onClick={sidePanel.open}>
                  {t("popup.viewAll", { count: String(summary.total) })}
                </Button>
              ) : null}
            </>
          ) : (
            <div class="pp-empty">{t("popup.resources.empty")}</div>
          )}
        </section>

        <section class="pp-section">
          <div class="pp-section-head">
            <span>{t("popup.tabs.tasks")}</span>
          </div>
          <TaskList density="compact" quickDownload />
        </section>
      </main>

      <footer class="pp-footer">
        <div class="pp-footer-left">
          <IconButton
            icon="settings"
            label={t("footer.settings")}
            onClick={() => {
              void browser.runtime.openOptionsPage();
              window.close();
            }}
          />
          {sidePanel.available ? (
            <IconButton icon="sidebar" label={t("popup.sidePanel")} onClick={sidePanel.open} />
          ) : null}
          <button
            type="button"
            class="pp-link"
            disabled={exporting}
            title={t("diagnostics.description")}
            onClick={exportDiagnostics}
          >
            {exporting ? t("diagnostics.exporting") : t("diagnostics.export")}
          </button>
        </div>
        <div class="pp-footer-right">
          <span class="pp-stats" title={t("stats.title")}>
            <Icon name="download" size={11} />
            <span class="pp-stat-ok">{stats.sent}</span>
            <span class="pp-stat-sep">·</span>
            <span class="pp-stat-fail">{stats.failed}</span>
          </span>
          <span class="pp-version">{version}</span>
        </div>
      </footer>
      <ToastHost />
    </div>
  );
}
