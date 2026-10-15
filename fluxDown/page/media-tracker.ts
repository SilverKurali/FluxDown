/**
 * 本帧媒体元素跟踪（ISOLATED world，sensor 使用）。
 *
 * 维护每个 video/audio 元素的稳定 key、播放 / 可见 / 交互状态与 MSE 绑定，
 * 500 ms 节流后以 `mediaElementState` 交给 background；同时向浮钮提供矩形命中、
 * 当前播放元素等查询。元素发现来源：初始扫描、MutationObserver、EV_MEDIA 事件目标。
 */
import type { ElementState } from "@/background/protocol";
import type { MediaDetail } from "./bridge";

export type ElementPayload = Omit<ElementState, "frameId">;

/** 浮钮 / 命中测试要求的最小可操作面积。 */
export const MIN_TARGET_W = 120;
export const MIN_TARGET_H = 80;

const SEND_THROTTLE_MS = 500;
const TIMEUPDATE_TICK_MS = 1000;
/** 播放中的 lastPlayedAt 仅在距上次上报超过该间隔时才触发上报，避免每秒刷新 background 视图。 */
const LAST_PLAYED_REPORT_MS = 15_000;

const MEDIA_EVENTS = [
  "play",
  "playing",
  "pause",
  "ended",
  "emptied",
  "loadedmetadata",
  "resize",
  "timeupdate",
] as const;

export interface TrackedMedia {
  readonly key: string;
  readonly el: HTMLMediaElement;
  readonly tag: "video" | "audio";
  playing: boolean;
  visibleRatio: number;
  lastPlayedAt: number;
  lastInteractionAt: number;
}

interface Item extends TrackedMedia {
  bindings: MediaDetail | null;
  lastTick: number;
  lastReportedPlayedAt: number;
  lastSentJson: string;
  handler: (e: Event) => void;
}

export interface MediaTrackerOptions {
  send(payload: { elements: ElementPayload[]; removed: string[] }): void;
}

function makeFrameUid(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    // 非安全上下文（http 页面）没有 randomUUID
    return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  }
}

export function isMediaTag(node: unknown): node is HTMLMediaElement {
  if (!node || typeof node !== "object") return false;
  const tag = (node as Element).tagName;
  return tag === "VIDEO" || tag === "AUDIO";
}

export class MediaTracker {
  private readonly frameUid = makeFrameUid();
  private seq = 0;
  private readonly keys = new WeakMap<Element, string>();
  private readonly items = new Map<string, Item>();
  private readonly dirty = new Set<string>();
  private readonly removedKeys = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private sendTimer: number | undefined;
  private mutationTimer: number | undefined;
  private readonly addedNodes = new Set<Element>();
  private sawRemoval = false;
  private io: IntersectionObserver | null = null;
  private ro: ResizeObserver | null = null;
  private mo: MutationObserver | null = null;
  private started = false;

  constructor(private readonly opts: MediaTrackerOptions) {}

  // ===== 生命周期 =====

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scan(document);
    document.addEventListener("pointerdown", this.onPointerDown, { capture: true, passive: true });
    this.mo = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) if (n.nodeType === 1) this.addedNodes.add(n as Element);
        if (r.removedNodes.length > 0) this.sawRemoval = true;
      }
      this.scheduleMutationFlush();
    });
    this.mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    document.removeEventListener("pointerdown", this.onPointerDown, { capture: true });
    this.mo?.disconnect();
    this.mo = null;
    for (const item of [...this.items.values()]) this.release(item, false);
    window.clearTimeout(this.sendTimer);
    window.clearTimeout(this.mutationTimer);
    this.sendTimer = undefined;
    this.mutationTimer = undefined;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ===== 元素发现 =====

  private scan(root: ParentNode): void {
    for (const el of root.querySelectorAll("video,audio")) this.adopt(el as HTMLMediaElement);
  }

  private scheduleMutationFlush(): void {
    if (this.mutationTimer !== undefined) return;
    this.mutationTimer = window.setTimeout(() => {
      this.mutationTimer = undefined;
      const added = [...this.addedNodes];
      this.addedNodes.clear();
      for (const node of added) {
        if (isMediaTag(node)) this.adopt(node);
        else if (node.childElementCount > 0) this.scan(node);
      }
      if (this.sawRemoval) {
        this.sawRemoval = false;
        for (const item of [...this.items.values()]) {
          if (!item.el.isConnected) this.release(item, true);
        }
      }
    }, 100);
  }

  /** 开始跟踪元素；已跟踪时直接返回。 */
  adopt(el: HTMLMediaElement): TrackedMedia {
    let key = this.keys.get(el);
    if (!key) {
      key = `${this.frameUid}:${++this.seq}`;
      this.keys.set(el, key);
    }
    const existing = this.items.get(key);
    if (existing) return existing;

    const handler = (e: Event): void => this.onMediaEvent(item, e.type);
    const item: Item = {
      key,
      el,
      tag: el.tagName === "AUDIO" ? "audio" : "video",
      playing: !el.paused && !el.ended,
      visibleRatio: 0,
      lastPlayedAt: !el.paused && !el.ended ? Date.now() : 0,
      lastInteractionAt: 0,
      bindings: null,
      lastTick: 0,
      lastReportedPlayedAt: 0,
      lastSentJson: "",
      handler,
    };
    this.items.set(key, item);
    this.removedKeys.delete(key);
    for (const name of MEDIA_EVENTS) el.addEventListener(name, handler, { passive: true });
    this.ensureObservers();
    this.io?.observe(el);
    this.ro?.observe(el);
    this.markDirty(item);
    return item;
  }

  private ensureObservers(): void {
    if (!this.io && typeof IntersectionObserver !== "undefined") {
      this.io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const item = this.itemOf(entry.target);
            if (!item) continue;
            item.visibleRatio = entry.isIntersecting ? entry.intersectionRatio : 0;
            this.markDirty(item);
          }
        },
        { threshold: [0, 0.5, 1] },
      );
    }
    if (!this.ro && typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const item = this.itemOf(entry.target);
          if (item) this.markDirty(item);
        }
      });
    }
  }

  private itemOf(el: Element): Item | undefined {
    const key = this.keys.get(el);
    return key ? this.items.get(key) : undefined;
  }

  private release(item: Item, report: boolean): void {
    for (const name of MEDIA_EVENTS) item.el.removeEventListener(name, item.handler);
    this.io?.unobserve(item.el);
    this.ro?.unobserve(item.el);
    this.items.delete(item.key);
    this.dirty.delete(item.key);
    if (report) {
      this.removedKeys.add(item.key);
      this.scheduleSend();
      this.notify();
    }
  }

  // ===== 状态来源 =====

  private onMediaEvent(item: Item, type: string): void {
    const el = item.el;
    const playing = !el.paused && !el.ended;
    const now = Date.now();
    if (type === "timeupdate") {
      if (now - item.lastTick < TIMEUPDATE_TICK_MS) return;
      item.lastTick = now;
      if (playing) {
        item.lastPlayedAt = now;
        if (now - item.lastReportedPlayedAt < LAST_PLAYED_REPORT_MS && item.playing === playing) return;
      }
    }
    if (playing) item.lastPlayedAt = now;
    item.playing = playing;
    if (type === "emptied") item.bindings = null;
    this.markDirty(item);
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    const hit = this.fromEvent(e);
    if (!hit) return;
    const item = this.items.get(hit.key);
    if (!item) return;
    item.lastInteractionAt = Date.now();
    this.markDirty(item);
  };

  /** 绑定 EV_MEDIA 的 MSE 归因。target 为 null（无元素）时仅当本帧恰有一个播放中的元素才归属。 */
  applyBinding(target: unknown, detail: MediaDetail): void {
    let item: Item | undefined;
    if (isMediaTag(target)) {
      this.adopt(target);
      item = this.itemOf(target);
    } else {
      const playing = [...this.items.values()].filter((i) => i.playing);
      if (playing.length === 1) item = playing[0];
    }
    if (!item) return;
    item.bindings = detail;
    this.markDirty(item);
  }

  private markDirty(item: Item): void {
    this.dirty.add(item.key);
    this.scheduleSend();
    this.notify();
  }

  private notify(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        /* 订阅方异常不影响跟踪 */
      }
    }
  }

  private scheduleSend(): void {
    if (this.sendTimer !== undefined) return;
    this.sendTimer = window.setTimeout(() => this.flush(), SEND_THROTTLE_MS);
  }

  private snapshot(item: Item): ElementPayload {
    const el = item.el;
    const rect = el.getBoundingClientRect();
    const src = el.currentSrc || "";
    const video = item.tag === "video" ? (el as HTMLVideoElement) : null;
    return {
      key: item.key,
      tag: item.tag,
      playing: item.playing,
      visibleRatio: Math.round(item.visibleRatio * 100) / 100,
      rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
      videoWidth: video?.videoWidth ?? 0,
      videoHeight: video?.videoHeight ?? 0,
      currentSrc: /^https?:/i.test(src) ? src : "",
      lastPlayedAt: item.lastPlayedAt,
      lastInteractionAt: item.lastInteractionAt,
      bindings: item.bindings?.sourceBuffers ?? [],
      tracks: [...el.querySelectorAll("track")].map((t) => ({
        kind: t.kind,
        srclang: t.srclang,
        label: t.label,
        src: t.src,
      })),
    };
  }

  private flush(): void {
    this.sendTimer = undefined;
    const elements: ElementPayload[] = [];
    for (const key of this.dirty) {
      const item = this.items.get(key);
      if (!item) continue;
      const payload = this.snapshot(item);
      const json = JSON.stringify(payload);
      if (json === item.lastSentJson) continue;
      item.lastSentJson = json;
      item.lastReportedPlayedAt = item.lastPlayedAt;
      elements.push(payload);
    }
    this.dirty.clear();
    const removed = [...this.removedKeys];
    this.removedKeys.clear();
    if (elements.length === 0 && removed.length === 0) return;
    this.opts.send({ elements, removed });
  }

  /** SPA 导航后 background 已清空元素状态：清掉发送去重并让所有现存元素重新上报。 */
  resetSent(): void {
    for (const [key, item] of this.items) {
      item.lastSentJson = "";
      this.dirty.add(key);
    }
    if (this.dirty.size > 0) this.markDirty(this.items.values().next().value as Item);
  }

  // ===== 查询（浮钮 / 右键） =====

  list(): TrackedMedia[] {
    return [...this.items.values()];
  }

  get(key: string): TrackedMedia | undefined {
    return this.items.get(key);
  }

  keyOf(el: Element): string | undefined {
    return this.keys.get(el);
  }

  /** 指针所在位置的视频：矩形命中（覆盖层是 video 的兄弟节点也命中），取面积最小者。 */
  elementAtPoint(x: number, y: number): TrackedMedia | null {
    let best: TrackedMedia | null = null;
    let bestArea = Infinity;
    for (const item of this.items.values()) {
      if (item.tag !== "video" || !item.el.isConnected) continue;
      const r = item.el.getBoundingClientRect();
      if (r.width < MIN_TARGET_W || r.height < MIN_TARGET_H) continue;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const area = r.width * r.height;
      if (area < bestArea) {
        best = item;
        bestArea = area;
      }
    }
    return best;
  }

  /** 事件命中的媒体元素：先看事件路径，再退化为指针矩形命中。 */
  fromEvent(e: MouseEvent): TrackedMedia | null {
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    for (const node of path) {
      if (isMediaTag(node)) {
        const key = this.keys.get(node);
        const item = key ? this.items.get(key) : undefined;
        if (item) return item;
      }
    }
    return this.elementAtPoint(e.clientX, e.clientY);
  }

  /** 本帧播放中的元素（rank ≥ 2）：可见比例高者优先，其次最近播放、面积。 */
  activePlaying(): TrackedMedia | null {
    let best: Item | null = null;
    let bestScore: [number, number, number] = [-1, -1, -1];
    for (const item of this.items.values()) {
      if (!item.playing || !item.el.isConnected) continue;
      const r = item.el.getBoundingClientRect();
      const score: [number, number, number] = [item.visibleRatio >= 0.5 ? 1 : 0, item.lastPlayedAt, r.width * r.height];
      if (
        score[0] > bestScore[0] ||
        (score[0] === bestScore[0] && (score[1] > bestScore[1] || (score[1] === bestScore[1] && score[2] > bestScore[2])))
      ) {
        best = item;
        bestScore = score;
      }
    }
    return best;
  }
}
