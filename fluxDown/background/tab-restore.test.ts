import { describe, expect, test } from "bun:test";
import type { DashManifest } from "@/utils/dash-manifest";
import type { DetectedResource } from "@/utils/resource-types";
import type { ElementState } from "./protocol";
import { mergeRestoredTab } from "./tab-restore";
import type { PersistedTab, RestorableState } from "./tab-restore";

const PAGE = "https://example.com/watch?v=1";

function resource(id: string): DetectedResource {
  return { id, url: `https://cdn.example.com/${id}.mp4` } as DetectedResource;
}

function element(key: string): ElementState {
  return { key } as ElementState;
}

function emptyState(pageUrl = ""): RestorableState {
  return { pageUrl, resources: new Map(), manifests: new Map(), elements: new Map() };
}

const saved: PersistedTab = {
  pageUrl: PAGE,
  resources: [resource("r1"), resource("r2")],
  manifests: [{ url: "https://cdn.example.com/a.mpd", manifest: { id: "m" } as unknown as DashManifest }],
  elements: [element("e1")],
};

const identity = (raw: unknown) => raw as DashManifest;

describe("mergeRestoredTab", () => {
  test("SW 被消息唤醒后已有空状态：快照仍被恢复（修复前整体跳过）", () => {
    const state = emptyState(); // stateOf() 先建出的空状态
    expect(mergeRestoredTab(state, saved, PAGE, identity)).toBe(true);
    expect([...state.resources.keys()]).toEqual(["r1", "r2"]);
    expect(state.manifests.size).toBe(1);
    expect([...state.elements.keys()]).toEqual(["e1"]);
    expect(state.pageUrl).toBe(PAGE);
  });

  test("实时数据优先，只补快照里有而实时没有的项", () => {
    const live = { ...resource("r1"), url: "https://live.example.com/r1.mp4" } as DetectedResource;
    const state = emptyState(PAGE);
    state.resources.set("r1", live);
    state.elements.set("e2", element("e2"));
    expect(mergeRestoredTab(state, saved, PAGE, identity)).toBe(true);
    expect(state.resources.get("r1")).toBe(live);
    expect(state.resources.has("r2")).toBe(true);
    expect([...state.elements.keys()].sort()).toEqual(["e1", "e2"]);
  });

  test("快照属于另一个页面：丢弃，不污染当前页", () => {
    const state = emptyState("https://example.com/other");
    expect(mergeRestoredTab(state, saved, undefined, identity)).toBe(false);
    expect(state.resources.size).toBe(0);
    // 实时 URL 未知时，以 tab 当前 URL 判断
    const unknown = emptyState();
    expect(mergeRestoredTab(unknown, saved, "https://example.com/other", identity)).toBe(false);
    expect(unknown.resources.size).toBe(0);
  });

  test("hash 变化不算换页", () => {
    const state = emptyState();
    expect(mergeRestoredTab(state, saved, `${PAGE}#t=30`, identity)).toBe(true);
    expect(state.resources.size).toBe(2);
  });
});
