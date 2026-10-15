/**
 * runtime.onMessage 路由（C6）。
 *
 * 消息分三族：`type` 族（任务面板 nmh-*、诊断）、`action` 族（C6 MessageMap）、
 * 以及兼容保留的 `appConfirmedUp`。
 *
 * Firefox：直接返回 Promise。Firefox MV2 中 "return true + 异步 sendResponse" 不可靠。
 * Chromium：Chrome 148 之前 onMessage 监听器不能返回 Promise，必须 "return true + sendResponse"。
 */
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { hostOf } from "@/rules/url";
import { installConnectionDiagnostics } from "@/utils/connection-diagnostics-background";
import { checkFluxDownAvailable, effectiveRemoteMode } from "@/utils/download-dispatch";
import {
  nmhOpenFile,
  nmhRevealFile,
  nmhTaskOp,
  nmhListTasks,
  nmhWarmupNativeHost,
} from "@/utils/native-messaging";
import { buildMediaCandidates } from "@/utils/media-candidates";
import { buildResourceDebugLog } from "@/utils/resource-debug-log";
import { profileFor } from "@/utils/site-profiles";
import { markAppUp } from "./breaker";
import {
  downloadCandidate,
  downloadResources,
  downloadUrls,
  handoffPage,
} from "./downloads";
import { getCapabilities, invalidateCapabilities } from "./host";
import { markPreempted } from "./intercept";
import type { PageConfig } from "@/page/bridge";
import type {
  HostStatus,
  MessageAction,
  MessageMap,
  PageLink,
  SendChannel,
} from "./protocol";
import { getEngine, getRuleSyncStatus, syncRemotePacks } from "./rules-store";
import { getCachedProfiles, getCachedSettings } from "./settings-cache";
import {
  addManifest,
  clearResourcesOnly,
  framesOf,
  getManifests,
  getResources,
  getTabPageUrl,
  ingestResources,
  pageUrlKey,
  registerFrame,
  setContextTarget,
  syncTabPageUrl,
  updateElements,
} from "./tab-state";
import { buildTabView } from "./tab-view";
import { processTasksPollResult } from "./tasks";
import { rowsForElement } from "./view-model";
import type { ResourceMessagePayload } from "@/utils/resource-types";
import type { Emitted, RuleRef } from "@/rules/engine";

type Sender = Browser.runtime.MessageSender;
type Handler<A extends MessageAction> = (
  req: MessageMap[A]["req"],
  sender: Sender,
) => Promise<MessageMap[A]["res"]>;

/** 每条 dom 规则最多处理的命中数。 */
const DOM_HITS_PER_RULE = 200;
const COLLECT_LINKS_TIMEOUT_MS = 3_000;
const MAX_LINKS = 5000;

function senderTabId(sender: Sender): number | undefined {
  const id = sender.tab?.id;
  return id !== undefined && id >= 0 ? id : undefined;
}

/** content script 以 sender.tab 为准（不信任页面自报）；扩展页用显式 tabId，缺省取活动 tab。 */
async function resolveTabId(sender: Sender, explicit?: number): Promise<number | undefined> {
  const fromSender = senderTabId(sender);
  if (fromSender !== undefined) return fromSender;
  if (typeof explicit === "number" && explicit >= 0) return explicit;
  try {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    return active?.id;
  } catch {
    return undefined;
  }
}

/** 全局嗅探开关与站点配置 sniff 都允许。 */
async function sniffEnabled(tabId: number, fallbackUrl: string): Promise<boolean> {
  const [settings, profiles] = await Promise.all([getCachedSettings(), getCachedProfiles()]);
  if (!settings.resourceSniffing) return false;
  return profileFor(profiles, hostOf(getTabPageUrl(tabId) || fallbackUrl)).profile.sniff;
}

function ingestEmit(
  tabId: number,
  pageUrl: string,
  frameId: number | undefined,
  rule: RuleRef,
  emit: Emitted,
  detectedBy: ResourceMessagePayload["detectedBy"],
): number {
  if (emit.mode === "preempt") {
    markPreempted(emit.url);
    return 1;
  }
  return ingestResources(
    tabId,
    pageUrl,
    [
      {
        url: emit.url,
        type: emit.type ?? getEngine().classify(emit.url),
        filename: emit.filename,
        quality: emit.quality,
        detectedBy,
        pageUrl,
      },
    ],
    { frameId, ruleIds: [rule.id] },
  );
}

async function collectFrameLinks(tabId: number, frameId: number): Promise<PageLink[]> {
  try {
    const reply: unknown = await Promise.race([
      browser.tabs.sendMessage(tabId, { action: "collectLinks" }, { frameId }),
      new Promise<undefined>((resolve) => setTimeout(resolve, COLLECT_LINKS_TIMEOUT_MS)),
    ]);
    if (reply && typeof reply === "object" && "links" in reply && Array.isArray(reply.links)) {
      return reply.links as PageLink[];
    }
  } catch {
    /* 该帧没有内容脚本 */
  }
  return [];
}

const handlers: { [A in MessageAction]: Handler<A> } = {
  async getPageConfig(req, sender) {
    const tabId = senderTabId(sender);
    const frameId = sender.frameId ?? 0;
    const [settings, profiles] = await Promise.all([getCachedSettings(), getCachedProfiles()]);
    if (tabId !== undefined) {
      registerFrame(tabId, frameId);
      if (frameId === 0) syncTabPageUrl(tabId, req.pageUrl, true);
    }
    const topUrl = (tabId !== undefined && getTabPageUrl(tabId)) || sender.tab?.url || req.pageUrl;
    const profile = profileFor(profiles, hostOf(topUrl)).profile;
    const engine = getEngine();
    const config: PageConfig = {
      sniff: settings.resourceSniffing && profile.sniff,
      bodyWatch: engine.bodyWatchers(req.pageUrl).map((w) => ({
        ruleId: w.rule.id,
        url: w.url,
        host: w.host,
        pathRegex: w.pathRegex,
      })),
      dom: engine.domRules(req.pageUrl).map((d) => ({
        ruleId: d.rule.id,
        selector: d.selector,
        attr: d.attr,
      })),
      floatButton: settings.showFloatingButton && profile.floatButton,
      floatTrigger: settings.floatButtonTrigger,
      pageDot: settings.showPageDot && profile.pageDot,
      frameIsTop: frameId === 0,
      interceptMagnet: settings.enabled && settings.interceptMagnet && profile.intercept !== "never",
      sniffImages: settings.sniffImages,
    };
    return config;
  },

  async sensorReport(req, sender) {
    const tabId = senderTabId(sender);
    if (tabId === undefined || req.resources.length === 0) return { added: 0 };
    const frameId = sender.frameId ?? 0;
    const tabUrl = getTabPageUrl(tabId);
    // 批量上报有 200 ms 合批延迟：顶层帧里页面 URL 与 tab 当前页不同的资源属于已离开的旧页面，
    // 直接丢弃；不能再用它去同步 tab 页面 URL（会把刚换页清空的状态又改回旧页并再次清空）。
    const resources =
      frameId === 0 && tabUrl
        ? req.resources.filter((r) => !r.pageUrl || pageUrlKey(r.pageUrl) === pageUrlKey(tabUrl))
        : req.resources;
    if (resources.length === 0) return { added: 0 };
    const pageUrl = resources.find((r) => r.pageUrl)?.pageUrl || sender.tab?.url || "";
    // 旧页面的 content script 可能仍在运行：开关关闭时丢弃。
    if (!(await sniffEnabled(tabId, pageUrl))) return { added: 0 };
    return { added: ingestResources(tabId, pageUrl, resources, { frameId }) };
  },

  async manifestObserved(req, sender) {
    const tabId = senderTabId(sender);
    if (tabId === undefined || !(await sniffEnabled(tabId, req.pageUrl))) return { ok: false };
    return { ok: addManifest(tabId, req.manifestUrl, req.manifest, req.pageUrl) };
  },

  async bodyObserved(req, sender) {
    const tabId = senderTabId(sender);
    if (tabId === undefined || !(await sniffEnabled(tabId, req.pageUrl))) return { emitted: 0 };
    let json: unknown;
    try {
      json = JSON.parse(req.text);
    } catch {
      return { emitted: 0 };
    }
    let emitted = 0;
    for (const { rule, emits } of getEngine().extractFromBody(req.url, req.pageUrl, json)) {
      for (const emit of emits) {
        emitted += ingestEmit(tabId, req.pageUrl, sender.frameId, rule, emit, "fetch-intercept");
      }
    }
    return { emitted };
  },

  async domObserved(req, sender) {
    const tabId = senderTabId(sender);
    if (tabId === undefined || !(await sniffEnabled(tabId, req.pageUrl))) return { emitted: 0 };
    const engine = getEngine();
    const rules = engine.domRules(req.pageUrl);
    const perRule = new Map<string, number>();
    let emitted = 0;
    for (const hit of req.hits) {
      const count = perRule.get(hit.ruleId) ?? 0;
      if (count >= DOM_HITS_PER_RULE) continue;
      perRule.set(hit.ruleId, count + 1);
      const entry = rules.find((r) => r.rule.id === hit.ruleId);
      if (!entry) continue;
      const emit = engine.renderDomEmit(entry.rule, entry.emit, { value: hit.value, text: hit.text });
      if (emit) emitted += ingestEmit(tabId, req.pageUrl, sender.frameId, entry.rule, emit, "dom-scan");
    }
    return { emitted };
  },

  async preemptDownload(req) {
    if (!req.url || typeof req.url !== "string") return { ok: false };
    // 蓝奏云等网站的 CDN URL 实际是 HTML 中转页：不发送给 FluxDown，仅记录 URL 防重复。
    markPreempted(req.url);
    return { ok: true };
  },

  async pageUrlChanged(req, sender) {
    const tabId = senderTabId(sender);
    // 只有顶层帧的 pageUrlChanged 才代表整页换址；子帧只做本地重置。
    if (tabId === undefined || !req.pageUrl || (sender.frameId ?? 0) !== 0) return { ok: false };
    syncTabPageUrl(tabId, req.pageUrl, true);
    return { ok: true };
  },

  async mediaElementState(req, sender) {
    const tabId = senderTabId(sender);
    if (tabId === undefined) return { ok: false };
    updateElements(tabId, sender.frameId ?? 0, req.elements, req.removed);
    return { ok: true };
  },

  async contextTarget(req, sender) {
    const tabId = senderTabId(sender);
    if (tabId === undefined) return { ok: false };
    setContextTarget(tabId, req.elementKey);
    return { ok: true };
  },

  async getElementCandidates(req, sender) {
    const tabId = senderTabId(sender);
    if (tabId === undefined) return { rows: [] };
    return { rows: rowsForElement(await buildTabView(tabId, { withHandoff: false }), req.elementKey) };
  },

  async getTabView(req, sender) {
    const tabId = await resolveTabId(sender, req.tabId);
    return tabId === undefined ? null : buildTabView(tabId);
  },

  async downloadCandidate(req, sender) {
    const tabId = await resolveTabId(sender, req.tabId);
    if (tabId === undefined) return { success: false, message: "No tab" };
    return downloadCandidate(tabId, req.candidateId, req.variantId, req.channel);
  },

  async downloadResources(req, sender) {
    const tabId = await resolveTabId(sender, req.tabId);
    if (tabId === undefined) return { success: false, message: "No tab" };
    return downloadResources(tabId, req.resourceIds, req.channel);
  },

  async downloadUrls(req, sender) {
    return downloadUrls(req.urls, req.referrer, await resolveTabId(sender, req.tabId), req.channel);
  },

  async handoffPage(req) {
    return handoffPage(req.tabId);
  },

  async clearResources(req, sender) {
    const tabId = await resolveTabId(sender, req.tabId);
    if (tabId === undefined) return { ok: false };
    clearResourcesOnly(tabId);
    return { ok: true };
  },

  async collectLinks(req) {
    const frames = new Set([0, ...framesOf(req.tabId)]);
    const results = await Promise.all([...frames].map((frameId) => collectFrameLinks(req.tabId, frameId)));
    const seen = new Set<string>();
    const links: PageLink[] = [];
    for (const link of results.flat()) {
      if (seen.has(link.url)) continue;
      seen.add(link.url);
      links.push(link);
      if (links.length >= MAX_LINKS) break;
    }
    return { links };
  },

  async openPanel(_req, sender) {
    const tabId = senderTabId(sender);
    if (tabId === undefined) return { ok: false };
    try {
      await browser.tabs.sendMessage(tabId, { action: "openPanel" }, { frameId: 0 });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  },

  async rulesTest(req) {
    const engine = getEngine();
    return {
      response: engine.classifyResponse(req),
      track: engine.trackKind({ url: req.url, mime: req.mime, pageUrl: req.pageUrl }),
      dedupeKey: engine.dedupeKey(req.url, req.pageUrl),
      fileExtension: engine.fileExtension(req.url, req.pageUrl),
    };
  },

  async rulesSyncNow() {
    return syncRemotePacks();
  },

  async getHostStatus() {
    const capabilities = await getCapabilities(true);
    // ping 成功 → 本机 App 已恢复：立即解除熔断，让「接管」与显示的「已连接」一致。
    // 远程 always 模式下 connected 是远程探测结果，不代表本机 App 在线。
    if (capabilities.connected && (await effectiveRemoteMode()) !== "always") markAppUp();
    const status: HostStatus = {
      connected: capabilities.connected,
      protocol: capabilities.protocol,
      capabilities,
      ruleSync: await getRuleSyncStatus(),
    };
    return status;
  },

  async rulesList() {
    return getEngine().listRules();
  },

  async getDebugLog(req) {
    const tabId = req.tabId;
    const view = await buildTabView(tabId, { withHandoff: false });
    const engine = getEngine();
    const key = (url: string) => engine.dedupeKey(url, view.pageUrl);
    const resources = getResources(tabId);
    const manifests = getManifests(tabId);
    const candidates = buildMediaCandidates(resources, {
      fallbackTitle: "Video",
      pageTitle: view.pageTitle,
      pageUrl: view.pageUrl,
      manifests,
      key,
    });
    return buildResourceDebugLog({
      source: "sidepanel",
      tabId,
      pageUrl: view.pageUrl,
      pageTitle: view.pageTitle,
      resources,
      manifests,
      candidates,
      key,
    });
  },
};

interface TypedMessage {
  type?: unknown;
  action?: unknown;
  [key: string]: unknown;
}

/** 任务面板（popup ↔ background）：`type` 族消息。返回 undefined 表示不属于本族。 */
async function handleTypeMessage(message: TypedMessage): Promise<unknown> {
  switch (message.type) {
    case "nmh-tasks": {
      const result = await nmhListTasks();
      if (!result.success) return { ok: false, connected: false, tasks: [] };
      await processTasksPollResult(result.tasks);
      return { ok: true, connected: true, tasks: result.tasks };
    }
    case "nmh-task-op": {
      const { op, taskId } = message;
      if (typeof taskId !== "string" || !taskId || (op !== "pause" && op !== "resume" && op !== "remove")) {
        return { ok: false, message: "invalid_request" };
      }
      const result = await nmhTaskOp(op, taskId);
      return { ok: result.success, message: result.message };
    }
    case "nmh-open-file":
    case "nmh-reveal-file": {
      const { taskId } = message;
      if (typeof taskId !== "string" || !taskId) return { ok: false, message: "invalid_request" };
      const result =
        message.type === "nmh-open-file" ? await nmhOpenFile(taskId) : await nmhRevealFile(taskId);
      return { ok: result.success, message: result.message };
    }
    case "nmh-warmup":
      nmhWarmupNativeHost();
      return { ok: true };
    default:
      return undefined;
  }
}

function isMessageAction(action: unknown): action is MessageAction {
  return typeof action === "string" && Object.hasOwn(handlers, action);
}

/** 安装 runtime.onMessage 路由；返回诊断处理器已在内部接入。 */
export function installMessages(): void {
  const handleDiagnostics = installConnectionDiagnostics();

  async function handleMessage(message: TypedMessage, sender: Sender): Promise<unknown> {
    if (message.type === "diagnostics-record" || message.type === "diagnostics-export") {
      return handleDiagnostics({ type: message.type, event: message.event }, sender);
    }
    const typed = await handleTypeMessage(message);
    if (typed !== undefined) return typed;

    // Popup 直连 ping NMH 成功后的熔断恢复信号（fire-and-forget）。
    if (message.action === "appConfirmedUp") {
      markAppUp();
      invalidateCapabilities();
      return { success: true };
    }
    if (isMessageAction(message.action)) {
      // 按 action 分发；各 handler 的 req 形状由 MessageMap 约定，发送方经 sendAction 类型化。
      const handler = handlers[message.action] as (req: unknown, s: Sender) => Promise<unknown>;
      return handler(message, sender);
    }
    return { error: "Unknown action" };
  }

  if (import.meta.env.FIREFOX) {
    browser.runtime.onMessage.addListener((message, sender) => {
      const reply = handleMessage(message as TypedMessage, sender).catch((err) => ({
        error: String(err),
      }));
      // 类型声明只允许 boolean 返回；Firefox 运行时接受 Promise。
      return reply as unknown as true;
    });
  } else {
    browser.runtime.onMessage.addListener(
      (message, sender, sendResponse: (response?: unknown) => void) => {
        const typed = message as TypedMessage;
        const respond = (): void => {
          handleMessage(typed, sender).then(sendResponse, (err) =>
            sendResponse({ error: String(err) }),
          );
        };
        // 浮钮「打开资源面板」优先打开浏览器右侧侧边栏。sidePanel.open 只在用户手势的
        // 同步调用栈内有效（内容脚本点击产生的消息会携带手势），所以必须在任何 await 之前调用；
        // 不支持或失败时回退为页内面板（转发给 frame 0）。
        const tabId = senderTabId(sender);
        if (typed.action === "openPanel" && tabId !== undefined && typeof browser.sidePanel?.open === "function") {
          browser.sidePanel.open({ tabId }).then(() => sendResponse({ ok: true }), respond);
          return true;
        }
        respond();
        return true;
      },
    );
  }
}

export type { SendChannel };
