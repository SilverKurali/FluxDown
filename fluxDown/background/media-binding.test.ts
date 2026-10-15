import { describe, expect, test } from "bun:test";
import { compileBuiltin } from "@/rules/engine";
import type { DashManifest } from "@/utils/dash-manifest";
import type { DetectedResource } from "@/utils/resource-types";
import { activeElement, bindCandidates, rankElement } from "./media-binding";
import type { ElementState } from "./protocol";
import { badgeCount, composeTabView } from "./view-model";
import type { ViewModelInput } from "./view-model";

const engine = compileBuiltin();
const PAGE_URL = "https://www.bilibili.com/video/BV1xx";

function element(overrides: Partial<ElementState> = {}): ElementState {
  return {
    key: "f1:1",
    frameId: 0,
    tag: "video",
    playing: true,
    visibleRatio: 1,
    rect: { w: 800, h: 450 },
    videoWidth: 1920,
    videoHeight: 1080,
    currentSrc: "",
    lastPlayedAt: 100,
    lastInteractionAt: 0,
    bindings: [],
    tracks: [],
    ...overrides,
  };
}

function dash(prefix: string): DashManifest {
  const base = `https://upos-sz-mirror.bilivideo.com/v1/${prefix}`;
  return {
    video: [
      { url: `${base}-1-30080.m4s`, mimeType: "video/mp4", width: 1920, height: 1080, bandwidth: 3_000_000, id: 30080 },
      { url: `${base}-1-30064.m4s`, mimeType: "video/mp4", width: 1280, height: 720, bandwidth: 1_500_000, id: 30064 },
    ],
    audio: [{ url: `${base}-1-30280.m4s`, mimeType: "audio/mp4", bandwidth: 128_000, id: 30280 }],
  };
}

function input(overrides: Partial<ViewModelInput>): ViewModelInput {
  return {
    tabId: 1,
    pageUrl: PAGE_URL,
    pageTitle: "Title",
    version: 1,
    resources: [],
    manifests: [],
    elements: [],
    engine,
    showLowConfidence: false,
    handoff: { kind: "no-match", installed: 0 },
    site: { host: "www.bilibili.com", profileKey: null, profile: { intercept: "default", sniff: true, pageDot: true, floatButton: true, saveDir: "" } },
    ...overrides,
  };
}

const manifests = [
  { url: "https://upos-sz-mirror.bilivideo.com/v1/cur.mpd", manifest: dash("cur") },
  { url: "https://upos-sz-mirror.bilivideo.com/v1/next.mpd", manifest: dash("next") },
];

describe("B 站预加载场景", () => {
  const cur = element({
    bindings: [
      { sbId: 1, mime: "video/mp4", kind: "video", exact: ["https://upos-sz-mirror.bilivideo.com/v1/cur-1-30080.m4s"], temporal: [] },
      { sbId: 2, mime: "audio/mp4", kind: "audio", exact: ["https://upos-sz-mirror.bilivideo.com/v1/cur-1-30280.m4s"], temporal: [] },
    ],
  });

  test("当前视频进入 playing，预加载的下一个进入 unbound，playingVariantId 指向 30080 档", () => {
    const view = composeTabView(input({ manifests, elements: [cur] }));
    expect(view.activeElementKey).toBe("f1:1");
    expect(view.playing).toHaveLength(1);
    expect(view.unbound).toHaveLength(1);
    const row = view.playing[0];
    expect(row.binding).toBe("exact");
    const playingVariant = row.candidate.variants.find((v) => v.id === row.playingVariantId);
    expect(playingVariant?.videoUrl).toContain("cur-1-30080.m4s");
    expect(view.unbound[0].candidate.variants[0].videoUrl).toContain("next-");
  });

  test("只有 temporal 计数时绑定到计数最高的家族，confidence 为 temporal", () => {
    const el = element({
      bindings: [
        {
          sbId: 1,
          mime: "video/mp4",
          kind: "video",
          exact: [],
          temporal: [
            { url: "https://upos-sz-mirror.bilivideo.com/v1/cur-1-30064.m4s", count: 5 },
            { url: "https://upos-sz-mirror.bilivideo.com/v1/next-1-30064.m4s", count: 1 },
          ],
        },
      ],
    });
    const view = composeTabView(input({ manifests, elements: [el] }));
    expect(view.playing).toHaveLength(1);
    const row = view.playing[0];
    expect(row.binding).toBe("temporal");
    const variant = row.candidate.variants.find((v) => v.id === row.playingVariantId);
    expect(variant?.videoUrl).toContain("cur-1-30064.m4s");
  });
});

describe("currentSrc 直链", () => {
  test("没有对应候选时合成 element: 候选", () => {
    const el = element({ currentSrc: "https://cdn.example.com/v/a.mp4", videoHeight: 720 });
    const view = composeTabView(input({ elements: [el] }));
    expect(view.playing).toHaveLength(1);
    const candidate = view.playing[0].candidate;
    expect(candidate.id).toBe("element:f1:1");
    expect(candidate.variants).toHaveLength(1);
    expect(candidate.variants[0].label).toBe("720p");
    expect(candidate.variants[0].videoUrl).toBe("https://cdn.example.com/v/a.mp4");
  });
});

describe("activeElement", () => {
  test("一个播放、一个暂停时取播放的那个", () => {
    const playing = element({ key: "a", playing: true, visibleRatio: 1 });
    const paused = element({ key: "b", playing: false, visibleRatio: 1, lastInteractionAt: 999 });
    expect(rankElement(playing)).toBe(3);
    expect(rankElement(paused)).toBe(1);
    expect(activeElement([paused, playing])?.key).toBe("a");
  });

  test("没有可见元素时为 null；同 rank 取最近播放", () => {
    expect(activeElement([element({ playing: false, visibleRatio: 0 })])).toBeNull();
    const a = element({ key: "a", lastPlayedAt: 10 });
    const b = element({ key: "b", lastPlayedAt: 20 });
    expect(activeElement([a, b])?.key).toBe("b");
  });
});

describe("抖音式大量直链", () => {
  function direct(i: number): DetectedResource {
    return {
      id: engine.dedupeKey(`https://v${i}.douyinvod.com/video/${i}.mp4`, "https://www.douyin.com/"),
      url: `https://v${i}.douyinvod.com/video/${i}.mp4`,
      filename: `${i}.mp4`,
      type: "video",
      size: 5_000_000,
      mimeType: "video/mp4",
      detectedBy: "webRequest",
      detectedAt: i,
      tabId: 1,
      pageUrl: "https://www.douyin.com/",
      confidence: "high",
    };
  }

  test("47 个直链中只有被 append 的 2 条进入 playing", () => {
    const resources = Array.from({ length: 47 }, (_, i) => direct(i));
    const el = element({
      bindings: [
        {
          sbId: 1,
          mime: "video/mp4",
          kind: "video",
          exact: [resources[3].url, resources[17].url],
          temporal: [],
        },
      ],
    });
    const view = composeTabView(input({ pageUrl: "https://www.douyin.com/", resources, elements: [el] }));
    expect(view.playing).toHaveLength(2);
    expect(view.playing.map((r) => r.candidate.variants[0].videoUrl).sort()).toEqual(
      [resources[3].url, resources[17].url].sort(),
    );
    expect(view.unbound.length).toBe(45);
  });
});

describe("徽标数", () => {
  test("等于各组可见行数之和（variants 计行）+ 文件数", () => {
    const el = element({
      bindings: [
        { sbId: 1, mime: "video/mp4", kind: "video", exact: ["https://upos-sz-mirror.bilivideo.com/v1/cur-1-30080.m4s"], temporal: [] },
      ],
    });
    const doc: DetectedResource = {
      id: "https://example.com/a.pdf",
      url: "https://example.com/a.pdf",
      filename: "a.pdf",
      type: "document",
      size: 10,
      detectedBy: "webRequest",
      detectedAt: 1,
      tabId: 1,
      pageUrl: PAGE_URL,
      confidence: "high",
    };
    const view = composeTabView(input({ manifests, elements: [el], resources: [doc] }));
    const rows = [...view.playing, ...view.otherElements, ...view.unbound];
    const expected = rows.reduce((n, r) => n + Math.max(r.candidate.variants.length, 1), 0) + 1;
    expect(view.files).toHaveLength(1);
    expect(badgeCount(view)).toBe(expected);
    expect(view.counts.all).toBe(expected);
  });
});

describe("bindCandidates", () => {
  test("同分时取 rank 更高的元素", () => {
    const view = composeTabView(input({ manifests, elements: [] }));
    expect(view.playing).toHaveLength(0);
    const candidates = view.unbound.map((r) => r.candidate);
    const url = "https://upos-sz-mirror.bilivideo.com/v1/cur-1-30080.m4s";
    const shared = [{ sbId: 1, mime: "video/mp4", kind: "video" as const, exact: [url], temporal: [] }];
    const paused = element({ key: "paused", playing: false, bindings: shared });
    const playing = element({ key: "playing", bindings: shared });
    const bound = bindCandidates(candidates, [paused, playing], (u) => engine.dedupeKey(u, PAGE_URL));
    expect([...bound.values()].some((b) => b.elementKey === "playing")).toBe(true);
    expect([...bound.values()].every((b) => b.elementKey !== "paused")).toBe(true);
  });
});
