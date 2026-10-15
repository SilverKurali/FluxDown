/**
 * MAIN world 钩子：fetch / XHR 嗅探、MSE 与响应来源归因、history 事件。
 *
 * 运行在页面自己的 JS 环境里（Chrome 由 page-hooks.content.ts 以 world: MAIN 注入，
 * Firefox 由 sensor 注入 page-hooks-main.js），通过 {@link ./bridge} 的 CustomEvent 与 ISOLATED world
 * 的 sensor 通信，detail 一律是 JSON 字符串。
 *
 * 铁律：所有钩子异常都必须走原函数，页面可见行为不变（#329 #337）。
 *
 * cat-catch(GPL-3.0) 嗅探思路的复用：JSON 内嵌媒体 URL 深扫见 utils/media-sniff.ts 归属说明。
 * 响应体流式部分读取与 MSE 归因为 FluxDown 自研。
 */
import { compileBuiltin } from "@/rules/engine";
import { hostMatchesPattern, parseHostPattern, urlGlobMatch, type HostPattern } from "@/rules/glob";
import { parseDashJson, parseDashXml } from "@/utils/dash-manifest";
import type { DashManifest } from "@/utils/dash-manifest";
import {
  isHttpUrl,
  isSkippableCt,
  looksLikeJson,
  scanForMediaUrls,
  sniffManifestMagic,
} from "@/utils/media-sniff";
import { isStreamingUrl } from "@/utils/resource-types";
import {
  EV_CONFIG,
  EV_MEDIA,
  EV_REPORT,
  decodeDetail,
  encodeDetail,
  type MediaDetail,
  type PageConfig,
  type ReportDetail,
  type SourceBufferBinding,
} from "./bridge";
import { RecentResponses, hasAnyTag, propagate, tag, tagsOf } from "./provenance";

/** 被包装的原函数（this 由调用点决定）。 */
type Orig = (this: unknown, ...args: unknown[]) => unknown;
/** 包装后的实现：参数类型由各钩子自行声明。 */
type Impl = (...args: never[]) => unknown;

const HOOK_FLAG = "__fluxdown_hooks__";

// 读体预算：仅对「非媒体 CT + 非流 URL + http + 非可跳过 CT + 体积可控」的响应读体，
// 避免大文件 / 流式响应被 clone-read 强制整体缓冲拖爆内存。
const MAX_SNIFF_CL = 2 * 1024 * 1024; // Content-Length 门槛：>2MB 不读
const MAX_SNIFF_READ = 512 * 1024; // 累积读上限：清单 / JSON API 均远小于此
const MAX_WATCH_BODY = 1024 * 1024; // body watcher 读体上限（超出则放弃，不上报半截 JSON）

const MEDIA_EXT_RE = /\.(?:m4s|ts|mp4|m4a|webm|aac)(?:[?#]|$)/i;
const NON_MEDIA_CT_RE = /^(?:text\/|application\/(?:json|javascript|x-javascript|xml)|image\/|font\/)|json/i;
/** 页面自己用 octet-stream 一类通用二进制 CT 传输的下载物（与 media 无关的兜底）。 */
const GENERIC_BINARY_CT = new Set([
  "application/octet-stream",
  "application/x-download",
  "application/force-download",
]);

export function start(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w[HOOK_FLAG]) return;
  w[HOOK_FLAG] = true;

  const rules = compileBuiltin();
  const recent = new RecentResponses();

  // ===== 配置（EV_CONFIG） =====

  interface Watcher {
    ruleId: string;
    urls?: string[];
    hosts?: HostPattern[];
    path?: RegExp;
  }

  /** 收到配置前按 sniff = true 处理，但不读取任何 body watcher 的正文。 */
  let config: PageConfig | null = null;
  let watchers: Watcher[] = [];

  function applyConfig(next: PageConfig): void {
    config = next;
    const compiled: Watcher[] = [];
    for (const b of next.bodyWatch) {
      const watcher: Watcher = { ruleId: b.ruleId };
      if (b.url?.length) watcher.urls = b.url;
      if (b.host?.length) {
        watcher.hosts = b.host
          .map((h) => parseHostPattern(h))
          .filter((p): p is HostPattern => p !== null);
      }
      if (b.pathRegex) {
        try {
          watcher.path = new RegExp(b.pathRegex, "i");
        } catch {
          continue;
        }
      }
      if (!watcher.urls && !watcher.hosts && !watcher.path) continue;
      compiled.push(watcher);
    }
    watchers = compiled;
  }

  document.addEventListener(EV_CONFIG, (event) => {
    try {
      const cfg = decodeDetail((event as CustomEvent).detail) as PageConfig | null;
      if (cfg && typeof cfg === "object" && typeof cfg.sniff === "boolean") {
        // 导航代数变化：background 已清空该页状态，去重集合需同步重置
        if (typeof cfg.epoch === "number" && cfg.epoch !== configEpoch) {
          configEpoch = cfg.epoch;
          notified.clear();
        }
        applyConfig(cfg);
      }
    } catch {
      /* 配置异常保持原状 */
    }
  });

  const sniffOn = (): boolean => config === null || config.sniff;
  const mediaEventsOn = (): boolean => config === null || config.sniff || config.floatButton;

  // ===== 上报 =====

  function dispatchReport(detail: ReportDetail): void {
    try {
      document.dispatchEvent(new CustomEvent(EV_REPORT, { detail: encodeDetail(detail) }));
    } catch {
      /* 上报失败无妨 */
    }
  }

  /** 已通知过的 URL（防重复）；整体清空而非删前半，下游仍有去重兜底。 */
  const notified = new Set<string>();
  let configEpoch = 0;

  function once(key: string): boolean {
    if (notified.has(key)) return false;
    notified.add(key);
    if (notified.size > 500) notified.clear();
    return true;
  }

  function notify(via: "fetch" | "xhr", url: string, mime?: string, size?: number): void {
    if (!sniffOn() || !url) return;
    if (!once(`${via}:${url}`)) return;
    dispatchReport({ t: "resource", url, mime, size, via });
  }

  function streamMime(url: string): string | undefined {
    const lower = url.toLowerCase();
    if (lower.includes(".m3u8")) return "application/vnd.apple.mpegurl";
    if (lower.includes(".mpd")) return "application/dash+xml";
    return undefined;
  }

  /** 响应 CT 是否值得上报为可下载资源（图片不报：由 webRequest 路径按 sniffImages 处理）。 */
  function isReportableCt(ct: string, url: string): boolean {
    const mime = ct.split(";")[0].trim().toLowerCase();
    if (!mime) return false;
    if (GENERIC_BINARY_CT.has(mime)) return true;
    const type = rules.classify(url, mime);
    return type !== "other" && type !== "image";
  }

  function isMediaCt(ct: string): boolean {
    const lower = ct.toLowerCase();
    return (
      lower.startsWith("video/") ||
      lower.startsWith("audio/") ||
      lower === "application/vnd.apple.mpegurl" ||
      lower === "application/x-mpegurl" ||
      lower === "application/mpegurl" ||
      lower === "application/octet-stream-m3u8" ||
      lower === "application/dash+xml"
    );
  }

  /** DASH 清单通常是 application/dash+xml，也可能是流 URL + text/xml/JSON。 */
  function isDashManifestResponse(ct: string, url: string): boolean {
    if (!isHttpUrl(url) || isSkippableCt(ct)) return false;
    const lower = ct.toLowerCase();
    if (lower.includes("dash+xml") || lower.startsWith("text/xml") || lower.startsWith("application/xml")) {
      return true;
    }
    if (lower.startsWith("text/html")) return false;
    // 通用 /playlist API 不当作 DASH；JSON DASH 由下方通用 JSON 分支兜底。
    return (
      /(?:\.mpd|\/manifest(?:\/|$))/i.test(url) &&
      !lower.startsWith("video/") &&
      !lower.startsWith("audio/") &&
      !lower.includes("mpegurl")
    );
  }

  function shouldReadBodyForSniff(ct: string, url: string): boolean {
    // 清单（.mpd / 清单 MIME）始终读取，供魔数检测
    if (isDashManifestResponse(ct, url)) return true;
    // 媒体分片不读正文：每个 .m4s/.ts 都 clone 并解码代价过高。无媒体扩展名的
    // octet-stream 仍读（保持旧行为：部分站点以 octet-stream 下发无扩展名的 m3u8）。
    const lower = ct.split(";")[0].trim().toLowerCase();
    if (MEDIA_EXT_RE.test(url) || lower.startsWith("video/") || lower.startsWith("audio/")) {
      return false;
    }
    return !isMediaCt(ct) && !isStreamingUrl(url) && isHttpUrl(url) && !isSkippableCt(ct);
  }

  // ===== 响应体清单 / JSON 深扫 =====

  function emitManifest(manifest: DashManifest | null, manifestUrl: string): void {
    if (!manifest) return;
    dispatchReport({ t: "manifest", manifestUrl, manifest });
  }

  function sniffTextForMedia(text: string, url: string, ct: string, via: "fetch" | "xhr"): void {
    try {
      if (!text) return;
      const magic = sniffManifestMagic(text.slice(0, 512));
      if (magic) {
        if (magic === "dash-manifest") emitManifest(parseDashXml(text, url), url);
        notify(via, url, magic === "hls-manifest" ? "application/vnd.apple.mpegurl" : "application/dash+xml");
        return;
      }
      if (text.length <= MAX_SNIFF_CL && looksLikeJson(ct, text)) {
        const obj: unknown = JSON.parse(text);
        emitManifest(parseDashJson(obj, url), url);
        for (const mediaUrl of scanForMediaUrls(obj, url)) notify(via, mediaUrl);
      }
    } catch {
      /* 嗅探异常绝不冒泡 */
    }
  }

  /** 有界累积读取（调用方传入 clone），随后解码；complete = 是否读到流尾。 */
  async function readBounded(
    response: Response,
    maxBytes: number,
    maxReads: number,
  ): Promise<{ text: string; complete: boolean } | null> {
    const body = response.body;
    if (!body) return null;
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let complete = false;
    try {
      for (let i = 0; i < maxReads && total < maxBytes; i++) {
        const { done, value } = await reader.read();
        if (done) {
          complete = true;
          break;
        }
        if (value) {
          chunks.push(value);
          total += value.length;
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* 取消失败无妨 */
      }
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.length;
    }
    return { text: new TextDecoder().decode(buf), complete };
  }

  async function readBodyAndSniff(response: Response, url: string, ct: string): Promise<void> {
    const r = await readBounded(response, MAX_SNIFF_READ, 8);
    if (r) sniffTextForMedia(r.text, url, ct, "fetch");
  }

  // ===== body watcher（声明式规则驱动，只在收到配置后生效） =====

  function watchedRuleIds(url: string): string[] {
    if (watchers.length === 0) return [];
    let parsed: URL;
    try {
      parsed = new URL(url, location.href);
    } catch {
      return [];
    }
    const full = parsed.href;
    const host = parsed.hostname.toLowerCase();
    const ids: string[] = [];
    for (const wt of watchers) {
      if (wt.urls && !wt.urls.some((p) => urlGlobMatch(p, full))) continue;
      if (wt.hosts && !wt.hosts.some((p) => hostMatchesPattern(host, p))) continue;
      if (wt.path && !wt.path.test(parsed.pathname)) continue;
      ids.push(wt.ruleId);
    }
    return ids;
  }

  function reportBody(url: string, ruleIds: string[], text: string): void {
    if (!text || text.length > MAX_WATCH_BODY) return;
    dispatchReport({ t: "body", url, ruleIds, text });
  }

  // ===== 响应来源打标 / MSE 归因 =====

  interface SbInfo {
    ms: MsInfo;
    sbId: number;
    mime: string;
    kind: SourceBufferBinding["kind"];
    exact: string[];
    temporal: Map<string, number>;
  }
  interface MsInfo {
    id: number;
    sbs: SbInfo[];
    el: WeakRef<HTMLMediaElement> | null;
    lastSent: number;
    timer: number | undefined;
  }

  let nextMsId = 1;
  let nextSbId = 1;
  const msOf = new WeakMap<object, MsInfo>();
  const msByObjectUrl = new Map<string, MsInfo>();
  const msOfElement = new WeakMap<object, MsInfo>();
  const hookedElements = new WeakSet<object>();
  const sbInfo = new WeakMap<object, SbInfo>();
  /** fetch 流 → 来源；reader → 来源（含是否已记入 recent）。 */
  const streamSource = new WeakMap<object, { url: string; media: boolean }>();
  const readerSource = new WeakMap<object, { url: string; media: boolean; pushed: boolean }>();

  function isMediaResponse(url: string, ct: string): boolean {
    const lower = ct.toLowerCase();
    return lower.startsWith("video/") || lower.startsWith("audio/") || MEDIA_EXT_RE.test(url);
  }

  /** 是否值得打标：明确的文本 / JSON / 图片 / 字体不打。 */
  function isTagWorthy(ct: string): boolean {
    return !ct || !NON_MEDIA_CT_RE.test(ct);
  }

  function tagResult(result: unknown, url: string, ct: string, byteLength: number): void {
    if (!url || !isTagWorthy(ct)) return;
    tag(result, url);
    if (isMediaResponse(url, ct)) recent.push(url, byteLength, Date.now());
  }

  function getMsInfo(ms: object): MsInfo {
    let info = msOf.get(ms);
    if (!info) {
      info = { id: nextMsId++, sbs: [], el: null, lastSent: 0, timer: undefined };
      msOf.set(ms, info);
    }
    return info;
  }

  function buildDetail(ms: MsInfo, elementless: boolean): MediaDetail {
    const detail: MediaDetail = {
      msId: ms.id,
      sourceBuffers: ms.sbs.map((sb) => ({
        sbId: sb.sbId,
        mime: sb.mime,
        kind: sb.kind,
        exact: sb.exact.slice(),
        temporal: [...sb.temporal.entries()].map(([url, count]) => ({ url, count })),
      })),
    };
    if (elementless) detail.elementless = true;
    return detail;
  }

  function flushMedia(ms: MsInfo): void {
    ms.timer = undefined;
    ms.lastSent = Date.now();
    if (!mediaEventsOn() || ms.sbs.length === 0) return;
    try {
      const el = ms.el?.deref();
      const init = { detail: "", composed: true, bubbles: false };
      if (el) {
        init.detail = encodeDetail(buildDetail(ms, false));
        el.dispatchEvent(new CustomEvent(EV_MEDIA, init));
      } else {
        init.detail = encodeDetail(buildDetail(ms, true));
        document.dispatchEvent(new CustomEvent(EV_MEDIA, init));
      }
    } catch {
      /* 派发失败无妨 */
    }
  }

  /** 1 s 节流：首次立即发，之后合并为 trailing。 */
  function scheduleMedia(ms: MsInfo): void {
    if (ms.timer !== undefined) return;
    const wait = 1000 - (Date.now() - ms.lastSent);
    if (wait <= 0) flushMedia(ms);
    else ms.timer = window.setTimeout(() => flushMedia(ms), wait);
  }

  const MEDIA_ELEMENT_EVENTS = ["play", "playing", "pause", "emptied", "loadedmetadata"];

  function linkElement(el: HTMLMediaElement, ms: MsInfo): void {
    ms.el = new WeakRef(el);
    msOfElement.set(el, ms);
    if (!hookedElements.has(el)) {
      hookedElements.add(el);
      const refresh = (): void => {
        const cur = msOfElement.get(el);
        if (cur) flushMedia(cur);
      };
      for (const name of MEDIA_ELEMENT_EVENTS) el.addEventListener(name, refresh, { passive: true });
    }
    scheduleMedia(ms);
  }

  function isMediaElement(value: unknown): value is HTMLMediaElement {
    return typeof HTMLMediaElement !== "undefined" && value instanceof HTMLMediaElement;
  }

  function linkBySrc(el: unknown, value: unknown): void {
    if (!isMediaElement(el)) return;
    if (typeof value === "string") {
      const ms = msByObjectUrl.get(value);
      if (ms) linkElement(el, ms);
    } else if (typeof MediaSource !== "undefined" && value instanceof MediaSource) {
      linkElement(el, getMsInfo(value));
    }
  }

  function onAppend(sb: object, data: unknown): void {
    const info = sbInfo.get(sb);
    if (!info) return;
    const tags = tagsOf(data);
    if (tags && tags.size > 0) {
      for (const url of tags) {
        const idx = info.exact.indexOf(url);
        if (idx >= 0) info.exact.splice(idx, 1);
        info.exact.push(url);
      }
      if (info.exact.length > 64) info.exact.splice(0, info.exact.length - 64);
    } else {
      for (const r of recent.withinWindow(Date.now())) {
        info.temporal.set(r.url, (info.temporal.get(r.url) ?? 0) + 1);
      }
      if (info.temporal.size > 16) {
        const top = [...info.temporal.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16);
        info.temporal = new Map(top);
      }
    }
    scheduleMedia(info.ms);
  }

  // ===== 安装钩子的小工具 =====

  /** 替换原型方法；make 拿到原函数返回新函数。安装失败静默跳过。 */
  function wrapMethod(proto: object | undefined, key: string, make: (orig: Orig) => Impl): void {
    try {
      if (!proto) return;
      const orig = (proto as Record<string, unknown>)[key];
      if (typeof orig !== "function") return;
      (proto as Record<string, unknown>)[key] = make(orig as Orig);
    } catch {
      /* 页面冻结了原型等情况：放弃该钩子 */
    }
  }

  function wrapSetter(proto: object | undefined, key: string, after: (self: unknown, value: unknown) => void): void {
    try {
      if (!proto) return;
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (!d?.set || !d.configurable) return;
      const origSet = d.set;
      Object.defineProperty(proto, key, {
        ...d,
        set(value: unknown) {
          origSet.call(this, value);
          try {
            after(this, value);
          } catch {
            /* 归因失败不影响页面 */
          }
        },
      });
    } catch {
      /* ignore */
    }
  }

  // ===== history：SPA 路由变化 =====

  let lastHref = location.href;
  const notifyPageUrl = (): void => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    dispatchReport({ t: "pageUrl" });
  };
  wrapMethod(history, "pushState", (orig) =>
    function (this: unknown, ...args: unknown[]) {
      const r = orig.apply(this, args);
      notifyPageUrl();
      return r;
    });
  wrapMethod(history, "replaceState", (orig) =>
    function (this: unknown, ...args: unknown[]) {
      const r = orig.apply(this, args);
      notifyPageUrl();
      return r;
    });
  window.addEventListener("popstate", notifyPageUrl);

  // ===== fetch =====

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      let url = "";
      try {
        const first = args[0];
        if (typeof first === "string") url = new URL(first, location.href).href;
        else if (first instanceof Request) url = first.url;
        else if (first instanceof URL) url = first.href;
      } catch {
        /* ignore */
      }

      try {
        if (url && isStreamingUrl(url)) notify("fetch", url, streamMime(url));
      } catch {
        /* 嗅探绝不打断页面请求 */
      }

      return originalFetch.apply(this, args).then((response) => {
        try {
          onFetchResponse(response, url);
        } catch {
          /* 不干扰原始响应 */
        }
        return response;
      });
    };
  }

  function onFetchResponse(response: Response, requestUrl: string): void {
    const ct = response.headers.get("content-type") || "";
    const clRaw = response.headers.get("content-length");
    const cl = clRaw ? parseInt(clRaw, 10) : undefined;
    const finalUrl = response.url || requestUrl;

    // 先 clone 再登记：clone 会把 response.body 换成 tee 出的新流，页面实际读取的是替换后的 body
    let sniffClone: Response | null = null;
    let watchClone: Response | null = null;
    let ids: string[] = [];
    if (sniffOn()) {
      if (ct && isReportableCt(ct, finalUrl)) notify("fetch", finalUrl, ct, cl);
      if (finalUrl && finalUrl !== requestUrl && isStreamingUrl(finalUrl)) {
        notify("fetch", finalUrl, ct || streamMime(finalUrl));
      }
      // 清单 / JSON 内嵌媒体 URL 深扫
      if (shouldReadBodyForSniff(ct, finalUrl) && (cl === undefined || cl <= MAX_SNIFF_CL)) {
        sniffClone = response.clone();
      }
      // 声明式 body watcher（如蓝奏云 /ajaxm.php）
      ids = watchedRuleIds(requestUrl || finalUrl);
      if (ids.length > 0 && (cl === undefined || cl <= MAX_WATCH_BODY)) watchClone = response.clone();
    }

    // 来源打标：流与后续 arrayBuffer/blob 的结果用响应 URL 归因
    if (response.body && finalUrl && isTagWorthy(ct)) {
      streamSource.set(response.body, { url: finalUrl, media: isMediaResponse(finalUrl, ct) });
    }

    if (sniffClone) readBodyAndSniff(sniffClone, finalUrl, ct).catch(() => {});
    if (watchClone) {
      const watchedUrl = requestUrl || finalUrl;
      readBounded(watchClone, MAX_WATCH_BODY, 64)
        .then((r) => {
          if (r?.complete) reportBody(watchedUrl, ids, r.text);
        })
        .catch(() => {});
    }
  }

  // ===== XMLHttpRequest =====

  const xhrUrls = new WeakMap<object, string>();

  wrapMethod(XMLHttpRequest.prototype, "open", (orig) =>
    function (this: XMLHttpRequest, ...args: unknown[]) {
      try {
        const url = args[1];
        let abs = "";
        if (typeof url === "string") abs = new URL(url, location.href).href;
        else if (url && typeof (url as URL).href === "string") abs = (url as URL).href;
        xhrUrls.set(this, abs);
        if (abs && isStreamingUrl(abs)) notify("xhr", abs, streamMime(abs));
      } catch {
        /* 嗅探异常绝不打断页面请求 */
      }
      return orig.apply(this, args);
    });

  wrapMethod(XMLHttpRequest.prototype, "send", (orig) =>
    function (this: XMLHttpRequest, ...args: unknown[]) {
      try {
        this.addEventListener("load", onXhrLoad);
      } catch {
        /* ignore */
      }
      return orig.apply(this, args);
    });

  function onXhrLoad(this: XMLHttpRequest): void {
    try {
      const url = xhrUrls.get(this);
      if (!url) return;
      const ct = this.getResponseHeader("content-type") || "";
      const cl = this.getResponseHeader("content-length");
      const responseUrl = this.responseURL || url;
      const rt = this.responseType;

      // 来源打标
      if (rt === "arraybuffer" && this.response instanceof ArrayBuffer) {
        tagResult(this.response, responseUrl, ct, this.response.byteLength);
      } else if (rt === "blob" && this.response instanceof Blob) {
        tagResult(this.response, responseUrl, ct, this.response.size);
      }

      if (!sniffOn()) return;
      if (ct && isReportableCt(ct, responseUrl)) {
        notify("xhr", responseUrl, ct, cl ? parseInt(cl, 10) : undefined);
      }
      if (responseUrl !== url && isStreamingUrl(responseUrl)) {
        notify("xhr", responseUrl, ct || streamMime(responseUrl));
      }

      if (shouldReadBodyForSniff(ct, responseUrl)) {
        if (rt === "" || rt === "text") {
          sniffTextForMedia(this.responseText, responseUrl, ct, "xhr");
        } else if (rt === "json" && this.response && typeof this.response === "object") {
          emitManifest(parseDashJson(this.response, responseUrl), responseUrl);
          for (const mediaUrl of scanForMediaUrls(this.response, responseUrl)) notify("xhr", mediaUrl);
        } else if (rt === "arraybuffer" && this.response instanceof ArrayBuffer) {
          const prefix = new Uint8Array(this.response).subarray(0, 512);
          const magic = sniffManifestMagic(new TextDecoder().decode(prefix));
          if (magic) {
            notify("xhr", responseUrl, magic === "hls-manifest" ? "application/vnd.apple.mpegurl" : "application/dash+xml");
          }
        }
      }

      const ids = watchedRuleIds(url);
      if (ids.length > 0) {
        if (rt === "" || rt === "text") reportBody(url, ids, this.responseText);
        else if (rt === "json" && this.response && typeof this.response === "object") {
          reportBody(url, ids, JSON.stringify(this.response));
        }
      }
    } catch {
      /* ignore */
    }
  }

  // ===== Response / Blob / Stream 来源传播 =====

  for (const key of ["arrayBuffer", "bytes"]) {
    wrapMethod(Response.prototype, key, (orig) =>
      function (this: Response, ...args: unknown[]) {
        const p = orig.apply(this, args) as Promise<ArrayBuffer | Uint8Array>;
        try {
          const url = this.url;
          if (!url || !(p instanceof Promise)) return p;
          const ct = this.headers.get("content-type") || "";
          return p.then((buf) => {
            try {
              tagResult(buf, url, ct, buf.byteLength);
            } catch {
              /* ignore */
            }
            return buf;
          });
        } catch {
          return p;
        }
      });
  }

  wrapMethod(Response.prototype, "blob", (orig) =>
    function (this: Response, ...args: unknown[]) {
      const p = orig.apply(this, args) as Promise<Blob>;
      try {
        const url = this.url;
        if (!url || !(p instanceof Promise)) return p;
        const ct = this.headers.get("content-type") || "";
        return p.then((blob) => {
          try {
            tagResult(blob, url, ct, blob.size);
          } catch {
            /* ignore */
          }
          return blob;
        });
      } catch {
        return p;
      }
    });

  wrapMethod(Blob.prototype, "arrayBuffer", (orig) =>
    function (this: Blob, ...args: unknown[]) {
      const p = orig.apply(this, args) as Promise<ArrayBuffer>;
      try {
        if (!hasAnyTag() || !tagsOf(this)) return p;
        return p.then((buf) => {
          try {
            propagate(this, buf);
          } catch {
            /* ignore */
          }
          return buf;
        });
      } catch {
        return p;
      }
    });

  wrapMethod(Blob.prototype, "slice", (orig) =>
    function (this: Blob, ...args: unknown[]) {
      const out = orig.apply(this, args);
      try {
        if (hasAnyTag()) propagate(this, out);
      } catch {
        /* ignore */
      }
      return out;
    });

  wrapMethod(ReadableStream.prototype, "getReader", (orig) =>
    function (this: ReadableStream, ...args: unknown[]) {
      const reader = orig.apply(this, args);
      try {
        const src = streamSource.get(this);
        if (src) readerSource.set(reader as object, { ...src, pushed: false });
      } catch {
        /* ignore */
      }
      return reader;
    });

  const readerProto =
    typeof ReadableStreamDefaultReader !== "undefined" ? ReadableStreamDefaultReader.prototype : undefined;
  wrapMethod(readerProto, "read", (orig) =>
    function (this: object, ...args: unknown[]) {
      const p = orig.apply(this, args) as Promise<ReadableStreamReadResult<Uint8Array>>;
      try {
        const src = readerSource.get(this);
        if (!src) return p;
        return p.then((res) => {
          try {
            if (res && res.value && res.value.buffer) {
              tag(res.value, src.url);
              if (!src.pushed && src.media) {
                src.pushed = true;
                recent.push(src.url, res.value.byteLength, Date.now());
              }
            }
          } catch {
            /* ignore */
          }
          return res;
        });
      } catch {
        return p;
      }
    });

  // ===== 拷贝路径传播：slice / set =====

  wrapMethod(ArrayBuffer.prototype, "slice", (orig) =>
    function (this: ArrayBuffer, ...args: unknown[]) {
      const out = orig.apply(this, args);
      try {
        if (hasAnyTag()) propagate(this, out);
      } catch {
        /* ignore */
      }
      return out;
    });

  const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype) as object | undefined;
  wrapMethod(typedArrayProto, "slice", (orig) =>
    function (this: ArrayBufferView, ...args: unknown[]) {
      const out = orig.apply(this, args);
      try {
        if (hasAnyTag()) propagate(this, out);
      } catch {
        /* ignore */
      }
      return out;
    });
  wrapMethod(typedArrayProto, "set", (orig) =>
    function (this: ArrayBufferView, ...args: unknown[]) {
      const r = orig.apply(this, args);
      try {
        if (hasAnyTag()) propagate(args[0], this);
      } catch {
        /* ignore */
      }
      return r;
    });

  // ===== MSE：createObjectURL / 元素绑定 / SourceBuffer =====

  wrapMethod(URL, "createObjectURL", (orig) =>
    function (this: unknown, ...args: unknown[]) {
      const url = orig.apply(this, args) as string;
      try {
        const obj = args[0];
        if (typeof MediaSource !== "undefined" && obj instanceof MediaSource) {
          msByObjectUrl.set(url, getMsInfo(obj));
          if (msByObjectUrl.size > 256) {
            const oldest = msByObjectUrl.keys().next().value;
            if (oldest !== undefined) msByObjectUrl.delete(oldest);
          }
        }
      } catch {
        /* ignore */
      }
      return url;
    });

  if (typeof HTMLMediaElement !== "undefined") {
    wrapSetter(HTMLMediaElement.prototype, "src", linkBySrc);
    wrapSetter(HTMLMediaElement.prototype, "srcObject", linkBySrc);
  }
  wrapMethod(Element.prototype, "setAttribute", (orig) =>
    function (this: Element, ...args: unknown[]) {
      const r = orig.apply(this, args);
      try {
        if (typeof args[0] === "string" && args[0].toLowerCase() === "src" && isMediaElement(this)) {
          linkBySrc(this, String(args[1]));
        }
      } catch {
        /* ignore */
      }
      return r;
    });

  if (typeof MediaSource !== "undefined") {
    wrapMethod(MediaSource.prototype, "addSourceBuffer", (orig) =>
      function (this: MediaSource, ...args: unknown[]) {
        const sb = orig.apply(this, args) as object;
        try {
          const mime = String(args[0] ?? "");
          const ms = getMsInfo(this);
          const lower = mime.toLowerCase();
          const info: SbInfo = {
            ms,
            sbId: nextSbId++,
            mime,
            kind: lower.startsWith("video") ? "video" : lower.startsWith("audio") ? "audio" : "unknown",
            exact: [],
            temporal: new Map(),
          };
          ms.sbs.push(info);
          sbInfo.set(sb, info);
        } catch {
          /* ignore */
        }
        return sb;
      });
  }
  if (typeof SourceBuffer !== "undefined") {
    wrapMethod(SourceBuffer.prototype, "appendBuffer", (orig) =>
      function (this: SourceBuffer, ...args: unknown[]) {
        try {
          onAppend(this, args[0]);
        } catch {
          /* 归因失败不影响 append */
        }
        return orig.apply(this, args);
      });
  }
}
