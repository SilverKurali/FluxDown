/**
 * FluxDown Background Service Worker 入口。
 *
 * 职责：拦截浏览器下载并转发给桌面应用（见 intercept.ts 的三层防线）、被动嗅探
 * （sniff.ts + sensor 上报 + 规则引擎）、右键菜单、与桌面端通信、统计、多语言。
 *
 * `startBackground` 同步注册全部 listener（MV3 要求事件监听器在 SW 首次执行时注册）。
 */
import { browser } from "wxt/browser";
import { initI18n, t } from "@/utils/i18n";
import { loadSettings, persistSettings } from "@/utils/settings";
import type { ContentMessage } from "./protocol";
import { restoreBreakerState } from "./breaker";
import { installCaptureTracker } from "./capture-tracker";
import {
  installIntercept,
  setInterceptListenersActive,
  syncDownloadShelfState,
} from "./intercept";
import { createContextMenus, installMenus } from "./menus";
import { installMessages } from "./messages";
import { notify } from "./notify";
import { installPorts } from "./ports";
import { installRequestCache } from "./request-cache";
import { installRulesStore, onEngineChanged } from "./rules-store";
import {
  getCachedSettings,
  installSettingsCacheListener,
  onSettingsChanged,
} from "./settings-cache";
import { installSniff } from "./sniff";
import { allFrames, installTabState } from "./tab-state";
import { installTaskListeners } from "./tasks";
import { updateIcon } from "./toolbar";

const LEGACY_PENDING_QUEUE_KEY = "pendingDownloadQueue";

/** 设置变化 / 启动预热：图标、下载栏隐藏、拦截监听的注册状态。 */
function applyInterceptState(): void {
  getCachedSettings()
    .then((s) => {
      updateIcon(s.enabled);
      // 同类产品（IDM/Motrix/FDM）共同使用的策略：拦截启用时隐藏下载 UI。
      syncDownloadShelfState(s.enabled);
      setInterceptListenersActive(s.enabled);
    })
    .catch((e) => {
      console.warn("[FluxDown] Settings cache warmup failed (non-fatal):", e);
    });
}

/** 规则 / 设置变化后，通知所有已登记帧重新拉取 PageConfig。 */
function broadcastPageConfigChanged(): void {
  const message: ContentMessage = { action: "pageConfigChanged" };
  for (const [tabId, frames] of allFrames()) {
    for (const frameId of frames) {
      browser.tabs.sendMessage(tabId, message, { frameId }).catch(() => {
        /* 该帧已不存在 */
      });
    }
  }
}

export function startBackground(): void {
  console.log("[FluxDown] Background service worker started");

  installSettingsCacheListener();
  installRequestCache();
  installTabState();
  installRulesStore();
  installSniff();
  installIntercept();
  installMenus();
  installTaskListeners();
  installCaptureTracker();
  installMessages();
  installPorts();
  restoreBreakerState();

  onSettingsChanged(applyInterceptState);
  onSettingsChanged(broadcastPageConfigChanged);
  onEngineChanged(broadcastPageConfigChanged);
  applyInterceptState();

  // 快捷键切换拦截开关（替代原来的 Alt+Click 绕过机制）
  browser.commands.onCommand.addListener(async (command) => {
    if (command !== "toggle-intercept") return;
    const settings = await loadSettings();
    const enabled = !settings.enabled;
    await persistSettings({ ...settings, enabled }, settings);
    updateIcon(enabled);
    syncDownloadShelfState(enabled);
    notify(
      t("shortcut.toggleTitle"),
      enabled ? t("shortcut.interceptOn") : t("shortcut.interceptOff"),
    );
  });

  // 清理已删除功能（发送失败重队列）的遗留数据。
  browser.storage.local.remove(LEGACY_PENDING_QUEUE_KEY).catch(() => {});

  // i18n 就绪后创建右键菜单（菜单标题需要翻译）。
  initI18n()
    .then(() => createContextMenus())
    .catch((e) => {
      console.warn("[FluxDown] i18n init failed (non-fatal):", e);
    });
}
