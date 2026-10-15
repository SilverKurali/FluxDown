import { describe, expect, test } from "bun:test";
import {
  buildMediaCandidates as buildMediaCandidatesRaw,
  candidateFilename,
  countMediaCandidateRows,
  isMediaCandidateVisible,
  selectQualityVideoTracks,
} from "./media-candidates";
import type { MediaCandidateOptions } from "./media-candidates";
import { compileBuiltin } from "@/rules/engine";
import { parseDashXml } from "./dash-manifest";
import type { DashManifest } from "./dash-manifest";
import type { DetectedResource } from "./resource-types";

const PAGE_URL = "https://example.com/watch";
const rules = compileBuiltin();

/** 测试里统一用内置规则的 dedupeKey 作为 URL 键。 */
function buildMediaCandidates(
  resources: DetectedResource[],
  options: Omit<MediaCandidateOptions, "key">,
) {
  return buildMediaCandidatesRaw(resources, {
    ...options,
    key: (url) => rules.dedupeKey(url, PAGE_URL),
  });
}


let sequence = 0;
function resource(overrides: Partial<DetectedResource>): DetectedResource {
  sequence += 1;
  return {
    id: `resource-${sequence}`,
    url: `https://cdn.example.com/resource-${sequence}.m4s`,
    filename: "",
    type: "stream",
    size: -1,
    detectedBy: "fetch-intercept",
    detectedAt: sequence,
    tabId: 1,
    pageUrl: PAGE_URL,
    confidence: "high",
    ...overrides,
  };
}

function manifest(
  videoQuery: string,
  audioQuery: string,
  directory = "video",
): DashManifest {
  return {
    video: [
      {
        id: "1080",
        url: `https://cdn.example.com/${directory}/1080.m4s?${videoQuery}`,
        mimeType: "video/mp4",
        codecs: "avc1.640028",
        bandwidth: 4_000_000,
        width: 1920,
        height: 1080,
      },
      {
        id: "360",
        url: `https://cdn.example.com/${directory}/360.m4s?${videoQuery}`,
        mimeType: "video/mp4",
        codecs: "avc1.4d401e",
        bandwidth: 700_000,
        width: 640,
        height: 360,
      },
    ],
    audio: [
      {
        id: "audio",
        url: `https://cdn.example.com/${directory}/audio.m4s?${audioQuery}`,
        mimeType: "audio/mp4",
        codecs: "mp4a.40.2",
        bandwidth: 128_000,
      },
    ],
  };
}

describe("buildMediaCandidates", () => {
  test("同一分辨率按普通帧率/高帧率各保留一档，并选择码率最高的轨道", () => {
    const tracks: DashManifest["video"] = [
      {
        id: "1080-av1",
        url: "https://cdn.example.com/1080-av1.m4s",
        height: 1080,
        bandwidth: 5_000_000,
        frameRate: 30,
      },
      {
        id: "1080-h264",
        url: "https://cdn.example.com/1080-h264.m4s",
        height: 1080,
        bandwidth: 8_000_000,
        frameRate: 30,
      },
      {
        id: "1080-60",
        url: "https://cdn.example.com/1080-60.m4s",
        height: 1080,
        bandwidth: 6_000_000,
        frameRate: 60,
      },
      {
        id: "720",
        url: "https://cdn.example.com/720.m4s",
        height: 720,
        bandwidth: 2_000_000,
        frameRate: 30,
      },
    ];

    const selected = selectQualityVideoTracks(tracks);
    expect(selected.map((track) => track.id)).toEqual([
      "1080-h264",
      "1080-60",
      "720",
    ]);
  });

  test("无 height 时按 bandwidth 保留不同清晰度档", () => {
    const selected = selectQualityVideoTracks([
      {
        id: "5m",
        url: "https://cdn.example.com/5m.m4s",
        bandwidth: 5_000_000,
      },
      {
        id: "2m",
        url: "https://cdn.example.com/2m.m4s",
        bandwidth: 2_000_000,
      },
      {
        id: "500k",
        url: "https://cdn.example.com/500k.m4s",
        bandwidth: 500_000,
      },
    ]);

    expect(selected.map((track) => track.id)).toEqual(["5m", "2m", "500k"]);
  });

  test("多个 Period 只在同一 Period 内配对音频", () => {
    const periodManifest = parseDashXml(`
      <MPD>
        <Period id="main">
          <AdaptationSet mimeType="video/mp4">
            <Representation id="main-1080" bandwidth="5000000" height="1080">
              <BaseURL>https://cdn.example.com/main/1080.m4s</BaseURL>
            </Representation>
          </AdaptationSet>
          <AdaptationSet mimeType="audio/mp4">
            <Representation id="main-audio" bandwidth="128000">
              <BaseURL>https://cdn.example.com/main/audio.m4s</BaseURL>
            </Representation>
          </AdaptationSet>
        </Period>
        <Period id="ad">
          <AdaptationSet mimeType="video/mp4">
            <Representation id="ad-720" bandwidth="2000000" height="720">
              <BaseURL>https://cdn.example.com/ad/720.m4s</BaseURL>
            </Representation>
          </AdaptationSet>
          <AdaptationSet mimeType="audio/mp4">
            <Representation id="ad-audio" bandwidth="320000">
              <BaseURL>https://cdn.example.com/ad/audio.m4s</BaseURL>
            </Representation>
          </AdaptationSet>
        </Period>
      </MPD>
    `, PAGE_URL);
    if (!periodManifest) throw new Error("expected a valid multi-Period MPD");

    const candidates = buildMediaCandidates([], {
      fallbackTitle: "Video",
      videoLabel: "Video",
      manifests: [{ url: "https://cdn.example.com/play/manifest.mpd", manifest: periodManifest }],
    });

    expect(candidates).toHaveLength(2);
    expect(candidates[0].variants[0].audioUrl).toBe("https://cdn.example.com/main/audio.m4s");
    expect(candidates[1].variants[0].audioUrl).toBe("https://cdn.example.com/ad/audio.m4s");
    expect(candidates.map((candidate) => candidate.title)).toEqual([
      "Video · Video 1",
      "Video · Video 2",
    ]);
  });

  test("SegmentTemplate 没有可下载轨道时回退到原始 MPD auto 候选", () => {
    const resources = [resource({
      id: "template-mpd",
      url: "https://cdn.example.com/video/manifest.mpd",
      type: "stream",
      mimeType: "application/dash+xml",
    })];
    const templateManifest: DashManifest = {
      video: [{
        id: "template-video",
        url: "https://cdn.example.com/video/manifest.mpd",
        height: 1080,
        bandwidth: 5_000_000,
        downloadable: false,
      }],
      audio: [{
        id: "template-audio",
        url: "https://cdn.example.com/video/manifest.mpd",
        bandwidth: 128_000,
        downloadable: false,
      }],
    };

    const candidates = buildMediaCandidates(resources, {
      fallbackTitle: "Video",
      manifests: [{ url: resources[0].url, manifest: templateManifest }],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].source).toBe("dash");
    expect(candidates[0].variants[0]).toMatchObject({
      label: "auto",
      videoUrl: resources[0].url,
      resourceId: "template-mpd",
    });
  });

  test("同标题的多个清单候选使用稳定的序号消歧", () => {
    const candidates = buildMediaCandidates([], {
      pageTitle: "第二个视频 BV2",
      fallbackTitle: "Video",
      videoLabel: "Video",
      manifests: [
        { url: "https://cdn.example.com/one/manifest.mpd", manifest: manifest("one", "one", "one") },
        { url: "https://cdn.example.com/two/manifest.mpd", manifest: manifest("two", "two", "two") },
      ],
    });

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.title)).toEqual([
      "第二个视频 BV2 · Video 1",
      "第二个视频 BV2 · Video 2",
    ]);
  });

  test("consumes raw video/audio tracks already represented by a DASH candidate", () => {
    const currentManifest = manifest("deadline=100&sig=one", "deadline=100&sig=one");
    const resources = [
      resource({
        id: "manifest",
        url: "https://cdn.example.com/play/manifest.json",
        type: "stream",
      }),
      resource({
        id: "video-1080",
        url: "https://cdn.example.com/video/1080.m4s?deadline=100&sig=one",
        type: "video",
        mimeType: "video/mp4",
      }),
      resource({
        id: "video-360",
        url: "https://cdn.example.com/video/360.m4s?deadline=100&sig=one",
        type: "video",
        mimeType: "video/mp4",
      }),
      resource({
        id: "audio",
        url: "https://cdn.example.com/audio/audio.m4s?deadline=100&sig=one",
        type: "audio",
        mimeType: "audio/mp4",
      }),
    ];

    const candidates = buildMediaCandidates(resources, {
      fallbackTitle: "Video",
      manifests: [
        {
          url: "https://cdn.example.com/play/manifest.json",
          manifest: currentManifest,
        },
      ],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].variants.map((variant) => variant.label)).toEqual([
      "1080p",
      "360p",
    ]);
    expect(candidates[0].rawResourceIds).toEqual(
      expect.arrayContaining(["manifest", "video-1080", "video-360", "audio"]),
    );
    expect(countMediaCandidateRows(candidates)).toBe(2);
  });

  test("deduplicates repeated manifests whose CDN signatures rotate", () => {
    const candidates = buildMediaCandidates([], {
      fallbackTitle: "Video",
      manifests: [
        {
          url: "https://cdn.example.com/play/manifest.json?session=one",
          manifest: manifest("deadline=100&sig=one", "deadline=100&sig=one"),
        },
        {
          url: "https://cdn.example.com/play/manifest.json?session=two",
          manifest: manifest("deadline=200&sig=two", "deadline=200&sig=two"),
        },
      ],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].variants).toHaveLength(2);
    expect(candidates[0].variants[0].videoUrl).toContain("deadline=200");
  });

  test("同一清单下不同目录的分片归入候选，且孤立分片不再占用资源数", () => {
    const currentManifest = manifest("deadline=100&sig=one", "deadline=100&sig=one");
    const resources = [
      resource({
        id: "manifest",
        url: "https://cdn.example.com/play/manifest.mpd",
        type: "stream",
      }),
      resource({
        id: "video-segment",
        url: "https://cdn.example.com/play/session-42/video/seg-1.m4s",
        type: "stream",
      }),
      resource({
        id: "orphan-a",
        url: "https://ads.example.com/other-player/a/seg-1.m4s",
        type: "stream",
      }),
      resource({
        id: "orphan-b",
        url: "https://ads.example.com/other-player/b/seg-1.m4s",
        type: "stream",
      }),
    ];

    const candidates = buildMediaCandidates(resources, {
      fallbackTitle: "Video",
      manifests: [{
        url: "https://cdn.example.com/play/manifest.mpd",
        manifest: currentManifest,
      }],
    });

    expect(candidates.filter((candidate) => candidate.downloadable)).toHaveLength(1);
    expect(candidates.find((candidate) => candidate.source === "dash")?.rawResourceIds)
      .toContain("video-segment");
    expect(candidates.find((candidate) => candidate.source === "fragments")?.fragmentCount)
      .toBe(2);
    // 页面已有可下载 dash 候选（2 档清晰度）时，孤立分片汇总只是噪声，
    // 不渲染、不计入角标。
    expect(countMediaCandidateRows(candidates)).toBe(2);
    const orphans = candidates.find((candidate) => candidate.source === "fragments");
    expect(orphans && isMediaCandidateVisible(orphans, candidates)).toBe(false);
  });

  test("MSE 站点未解析到清单时，分片汇总以一条禁用行可见并计入角标", () => {
    const resources = [
      resource({ id: "v1", url: "https://cdn.example.com/mse/video/seg-1.m4s", type: "stream" }),
      resource({ id: "v2", url: "https://cdn.example.com/mse/video/seg-2.m4s", type: "stream" }),
      resource({ id: "a1", url: "https://cdn.example.com/mse/audio/seg-1.m4s", type: "stream" }),
    ];

    const candidates = buildMediaCandidates(resources, { fallbackTitle: "Video", manifests: [] });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].source).toBe("fragments");
    expect(candidates[0].downloadable).toBe(false);
    expect(candidates[0].rawResourceIds).toEqual(["v1", "v2", "a1"]);
    expect(isMediaCandidateVisible(candidates[0], candidates)).toBe(true);
    expect(countMediaCandidateRows(candidates)).toBe(1);
  });

  test("filename 为 URL 基名（store 真实形态）的分片仍归为分片汇总，不逐个展示", () => {
    const resources = ["seg-1.ts", "seg-2.ts", "seg-3.ts"].map((name, i) =>
      resource({
        id: `ts${i}`,
        url: `https://cdn.example.com/hls/${name}`,
        filename: name,
        type: "stream",
        size: 1_500_000,
      }),
    );

    const candidates = buildMediaCandidates(resources, { fallbackTitle: "Video", manifests: [] });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].source).toBe("fragments");
  });

  test("备用 CDN 使用相同媒体路径时归入 DASH 候选", () => {
    const currentManifest = manifest("deadline=100&sig=one", "deadline=100&sig=one");
    const resources = [
      resource({
        id: "manifest",
        url: "https://cdn.example.com/play/manifest.mpd",
        type: "stream",
      }),
      resource({
        id: "video-primary",
        url: "https://cdn.example.com/video/1080.m4s?deadline=100&sig=one",
        type: "video",
      }),
      resource({
        id: "video-mirror",
        url: "https://mirror.example.net/video/1080.m4s?deadline=100&sig=two",
        type: "video",
      }),
      resource({
        id: "audio-mirror",
        url: "https://mirror.example.net/video/audio.m4s?deadline=100&sig=two",
        type: "audio",
      }),
    ];

    const candidates = buildMediaCandidates(resources, {
      fallbackTitle: "Video",
      manifests: [{
        url: "https://cdn.example.com/play/manifest.mpd",
        manifest: currentManifest,
      }],
    });

    expect(candidates.filter((candidate) => candidate.source === "fragments")).toHaveLength(0);
    expect(candidates[0].rawResourceIds).toEqual(
      expect.arrayContaining(["video-mirror", "audio-mirror"]),
    );
    expect(countMediaCandidateRows(candidates)).toBe(2);
  });

  test("当前页面有强关联清单时忽略其他视频的预加载清单和分片", () => {
    const currentManifest = manifest("deadline=100&sig=current", "deadline=100&sig=current", "current");
    const preloadManifest = manifest("deadline=100&sig=preload", "deadline=100&sig=preload", "preload");
    const resources = [
      resource({
        id: "current-video",
        url: "https://cdn.example.com/current/1080.m4s?deadline=100&sig=current",
        type: "video",
      }),
      resource({
        id: "current-audio",
        url: "https://cdn.example.com/current/audio.m4s?deadline=100&sig=current",
        type: "audio",
      }),
      resource({
        id: "preload-video",
        url: "https://cdn.example.com/preload/1080.m4s?deadline=100&sig=preload",
        type: "video",
      }),
      resource({
        id: "preload-audio",
        url: "https://cdn.example.com/preload/audio.m4s?deadline=100&sig=preload",
        type: "audio",
      }),
    ];

    const candidates = buildMediaCandidates(resources, {
      pageTitle: "Current video",
      pageUrl: "https://example.com/watch/current",
      fallbackTitle: "Video",
      manifests: [
        {
          url: "https://example.com/watch/current",
          manifest: currentManifest,
        },
        {
          url: "https://api.example.com/play?id=preload",
          manifest: preloadManifest,
        },
      ],
    });

    expect(candidates.filter((candidate) => candidate.downloadable)).toHaveLength(1);
    expect(candidates.find((candidate) => candidate.source === "dash")?.rawResourceIds)
      .toEqual(expect.arrayContaining(["current-video", "current-audio"]));
    expect(candidates.find((candidate) => candidate.source === "fragments")).toBeUndefined();
    expect(candidates.find((candidate) => candidate.source === "ignored")?.rawResourceIds)
      .toEqual(expect.arrayContaining(["preload-video", "preload-audio"]));
    expect(countMediaCandidateRows(candidates)).toBe(2);
  });

  test("issue #16: HLS 候选下载文件名取自页面标题（消毒后）而非 CDN 分片原始名", () => {
    const resources = [
      resource({
        id: "hls-1",
        url: "https://cdn.example.com/live/index-v1-a1.m3u8",
        type: "stream",
        mimeType: "application/vnd.apple.mpegurl",
      }),
    ];

    const candidates = buildMediaCandidates(resources, {
      pageTitle: 'My "Cool" Video: Part 1/2',
      pageUrl: PAGE_URL,
      fallbackTitle: "Video",
    });

    const hls = candidates.find((candidate) => candidate.source === "hls");
    expect(hls).toBeDefined();
    const filename = candidateFilename(hls!, hls!.variants[0]);
    // 扩展名 .ts：HLS auto 候选走引擎 HLS 下载器，产物即分片拼接，见
    // variantExtension 对 m3u8 → ts 的映射说明。
    expect(filename).toBe("My Cool Video Part 1 2.ts");
    expect(filename).not.toContain("index-v1-a1");
  });
});
