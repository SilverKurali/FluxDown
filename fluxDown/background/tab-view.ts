/** 从 tab-state / settings / host 取数据，交给纯函数 composeTabView 生成 TabView。 */
import { browser } from "wxt/browser";
import { effectiveRemoteMode } from "@/utils/download-dispatch";
import { profileFor } from "@/utils/site-profiles";
import { getCapabilities } from "./host";
import type { TabView } from "./protocol";
import { getEngine } from "./rules-store";
import { getCachedProfiles, getCachedSettings } from "./settings-cache";
import { getElements, getManifests, getResources, getTabPageUrl, getTabVersion } from "./tab-state";
import { composeTabView, handoffFor } from "./view-model";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function tabTitle(tabId: number): Promise<{ title: string; url: string }> {
  try {
    const tab = await browser.tabs.get(tabId);
    return { title: tab.title ?? "", url: tab.url ?? "" };
  } catch {
    return { title: "", url: "" };
  }
}

/** `withHandoff: false`：不探测桌面端能力（徽标刷新、下载取候选等不需要 handoff 的路径）；handoff 填占位值。 */
export async function buildTabView(tabId: number, opts: { withHandoff?: boolean } = {}): Promise<TabView> {
  const withHandoff = opts.withHandoff ?? true;
  const [settings, profiles, caps, remoteMode, tab] = await Promise.all([
    getCachedSettings(),
    getCachedProfiles(),
    withHandoff ? getCapabilities() : Promise.resolve(null),
    withHandoff ? effectiveRemoteMode() : Promise.resolve("off" as const),
    tabTitle(tabId),
  ]);
  const engine = getEngine();
  const resources = getResources(tabId);
  const pageUrl = getTabPageUrl(tabId) || resources.find((r) => r.pageUrl)?.pageUrl || tab.url;
  const host = hostOf(pageUrl);
  const { key: profileKey, profile } = profileFor(profiles, host);
  const site: TabView["site"] = {
    host,
    profileKey,
    profile,
  };
  return composeTabView({
    tabId,
    pageUrl,
    pageTitle: tab.title,
    version: getTabVersion(tabId),
    resources,
    manifests: getManifests(tabId),
    elements: getElements(tabId),
    engine,
    showLowConfidence: settings.showLowConfidence,
    handoff: caps ? handoffFor({ remoteMode, caps, pageUrl }) : { kind: "unavailable", reason: "disconnected" },
    site,
  });
}
