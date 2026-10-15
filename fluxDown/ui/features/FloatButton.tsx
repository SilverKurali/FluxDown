/**
 * 视频浮钮（每帧一个实例，由 sensor.content.ts 创建）。
 *
 * 目标元素只来自本帧已跟踪的 video 元素（矩形命中 / 正在播放），候选只取绑定到该元素的行
 * （getElementCandidates），不再回退到「整页所有媒体」（#336）；显示期间每帧读取元素矩形，
 * 滚动时按钮跟随（#275）；全屏时把 UI 重挂到全屏元素内。
 */
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { createShadowRootUi, type ShadowRootContentScriptUi } from "wxt/utils/content-script-ui/shadow-root";
import type { CandidateRow } from "@/background/protocol";
import type { PageConfig } from "@/page/bridge";
import { MIN_TARGET_H, MIN_TARGET_W, isMediaTag, type MediaTracker, type TrackedMedia } from "@/page/media-tracker";
import { Icon } from "@/ui/components/Icon";
import { ToastHost, showToast } from "@/ui/components/Toast";
import { useT } from "@/ui/i18n";
import { useThemeAttr } from "@/ui/theme";
import { initI18n } from "@/utils/i18n";
import { sendAction } from "@/utils/messaging";
import { QualityPicker } from "./QualityPicker";
import { variantLabel } from "./labels";
import "@/ui/theme/tokens.css";
import "@/ui/theme/base.css";
import "./float.css";

export interface FloatButtonController {
  /** 配置变化：决定是否启用、触发方式。 */
  setConfig(config: PageConfig | null): void;
  destroy(): void;
}

export interface FloatButtonDeps {
  ctx: ContentScriptContext;
  tracker: MediaTracker;
  /** 规则匹配用的页面 URL（下载直链时作 referrer 的是 location.href）。 */
  pageUrl(): string;
}

const HIDE_DELAY_MS = 400;
const BTN_MARGIN = 8;
const CANDIDATE_POLL_MS = 2000;
const FLASH_MS = 1500;

function fullscreenElementOf(): Element | null {
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function httpSrcOf(el: HTMLMediaElement): string {
  const src = el.currentSrc || "";
  return /^https?:/i.test(src) ? src : "";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

interface FloatRootProps {
  tracker: MediaTracker;
  config: PageConfig;
  host: HTMLElement;
}

function FloatRoot(props: FloatRootProps): JSX.Element {
  const { tracker, config, host } = props;
  const t = useT();
  useThemeAttr(host);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<TrackedMedia | null>(null);
  const [rows, setRows] = useState<CandidateRow[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [, setTick] = useState(0);

  const menuOpenRef = useRef(false);
  menuOpenRef.current = menuOpen;
  const hoverRef = useRef(false);
  const evaluateRef = useRef<(() => void) | null>(null);
  const rowsRef = useRef<CandidateRow[]>([]);
  rowsRef.current = rows;
  const trigger = config.floatTrigger;

  // ===== 目标元素选择 =====
  useEffect(() => {
    let raf = 0;
    let hideTimer: number | undefined;
    let x = -1;
    let y = -1;
    let current: TrackedMedia | null = null;
    let pending = false;

    const choose = (next: TrackedMedia | null): void => {
      if ((next?.key ?? null) === (current?.key ?? null)) return;
      current = next;
      setTarget(next);
      if (!next) setMenuOpen(false);
    };

    const evaluate = (): void => {
      if (current && !tracker.get(current.key)) {
        choose(null);
        return;
      }
      if (trigger === "always") {
        const active = tracker.activePlaying();
        const r = active?.el.getBoundingClientRect();
        choose(active && r && r.width >= MIN_TARGET_W && r.height >= MIN_TARGET_H ? active : null);
        return;
      }
      const hit = tracker.elementAtPoint(x, y);
      if (hit) {
        window.clearTimeout(hideTimer);
        hideTimer = undefined;
        choose(hit);
      } else if (current && hideTimer === undefined && !hoverRef.current && !menuOpenRef.current) {
        hideTimer = window.setTimeout(() => {
          hideTimer = undefined;
          if (!hoverRef.current && !menuOpenRef.current) choose(null);
        }, HIDE_DELAY_MS);
      }
    };

    const schedule = (): void => {
      if (pending) return;
      pending = true;
      raf = requestAnimationFrame(() => {
        pending = false;
        evaluate();
      });
    };

    const onMove = (e: PointerEvent): void => {
      x = e.clientX;
      y = e.clientY;
      schedule();
    };
    const onLeave = (): void => {
      x = -1;
      y = -1;
      schedule();
    };

    if (trigger === "hover") {
      document.addEventListener("pointermove", onMove, { capture: true, passive: true });
      document.documentElement.addEventListener("pointerleave", onLeave, { passive: true });
    }
    const unsubscribe = tracker.subscribe(schedule);
    // 滚动 / 布局变化时指针不动：位置循环每帧调用 evaluateRef 重新评估
    evaluateRef.current = evaluate;
    schedule();

    return () => {
      document.removeEventListener("pointermove", onMove, { capture: true });
      document.documentElement.removeEventListener("pointerleave", onLeave);
      unsubscribe();
      cancelAnimationFrame(raf);
      window.clearTimeout(hideTimer);
      evaluateRef.current = null;
    };
  }, [tracker, trigger]);

  // ===== 候选（只取绑定到目标元素的行） =====
  const targetKey = target?.key ?? null;
  useEffect(() => {
    setRows([]);
    if (!targetKey) return;
    let alive = true;
    let debounce: number | undefined;
    const load = async (): Promise<void> => {
      try {
        const res = await sendAction({ action: "getElementCandidates", elementKey: targetKey });
        if (alive) setRows(res?.rows ?? []);
      } catch {
        /* 扩展失效 / 后台唤醒中：下一轮重试 */
      }
    };
    void load();
    // 绑定晚于播放到达：元素状态变化后重取；无行时周期轮询
    const unsubscribe = tracker.subscribe(() => {
      setTick((n) => n + 1);
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => void load(), 700);
    });
    const poll = window.setInterval(() => {
      if (rowsRef.current.length === 0) void load();
    }, CANDIDATE_POLL_MS);
    return () => {
      alive = false;
      unsubscribe();
      window.clearInterval(poll);
      window.clearTimeout(debounce);
    };
  }, [tracker, targetKey]);

  // ===== 显示判定 =====
  const el = target?.el ?? null;
  const directSrc = rows.length === 0 && el ? httpSrcOf(el) : "";
  const videoFullscreen = !!el && fullscreenElementOf() === el;
  const showBtn = !!target && (rows.length > 0 || directSrc !== "") && !videoFullscreen;

  // ===== 位置跟随：每帧读取元素矩形 =====
  useEffect(() => {
    if (!el || !showBtn) return;
    let raf = 0;
    const loop = (): void => {
      const wrap = wrapRef.current;
      if (wrap) {
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const offscreen =
          !el.isConnected || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw || r.width < 40 || r.height < 40;
        if (offscreen || fullscreenElementOf() === el) {
          wrap.style.visibility = "hidden";
        } else {
          const bw = wrap.offsetWidth || 80;
          const bh = wrap.offsetHeight || 28;
          const left = clamp(r.right - bw - BTN_MARGIN, 4, vw - bw - 4);
          const top = clamp(r.top + BTN_MARGIN, 4, vh - bh - 4);
          wrap.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
          wrap.style.visibility = "visible";
        }
      }
      evaluateRef.current?.();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [el, showBtn]);

  // ===== 弹层：点击外部 / Esc 关闭 =====
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: Event): void => {
      const wrap = wrapRef.current;
      if (wrap && !e.composedPath().includes(wrap)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menuOpen]);

  if (!showBtn || !target) return <ToastHost />;

  // ===== 标签：播放档 > videoHeight > 默认文案 =====
  const playingRow = rows.find((r) => r.playingVariantId);
  const playingVariant = playingRow?.candidate.variants.find((v) => v.id === playingRow.playingVariantId);
  const height = target.tag === "video" ? (target.el as HTMLVideoElement).videoHeight : 0;
  // 档位标签走与清晰度菜单相同的本地化（auto / original 等内部值不直接外露）
  const label = playingVariant
    ? variantLabel(t, playingVariant)
    : height > 0
      ? `${height}p`
      : t("float.download");

  const flash = (kind: "done" | "error", message?: string): void => {
    setState(kind);
    if (kind === "error") showToast(message || t("float.failed"), "error");
    window.setTimeout(() => setState("idle"), FLASH_MS);
  };

  const send = async (run: () => Promise<{ success: boolean; message?: string } | undefined>): Promise<void> => {
    setState("busy");
    try {
      const res = await run();
      if (res?.success) flash("done");
      else flash("error", res?.message);
    } catch (e) {
      flash("error", e instanceof Error ? e.message : undefined);
    }
  };

  const onClick = (): void => {
    if (state === "busy") return;
    const only = rows.length === 1 ? rows[0] : null;
    if (only && only.candidate.variants.length === 1 && only.candidate.downloadable) {
      void send(() =>
        sendAction({
          action: "downloadCandidate",
          candidateId: only.candidate.id,
          variantId: only.candidate.variants[0].id,
        }),
      );
      return;
    }
    if (rows.length === 0 && directSrc) {
      void send(() => sendAction({ action: "downloadUrls", urls: [directSrc], referrer: location.href }));
      return;
    }
    const wrap = wrapRef.current;
    if (wrap) setFlip(wrap.getBoundingClientRect().bottom + 300 > window.innerHeight);
    setMenuOpen((open) => !open);
  };

  const stop = (e: Event): void => e.stopPropagation();

  return (
    <>
      <div
        class="fd-float-wrap"
        ref={wrapRef}
        onPointerEnter={() => (hoverRef.current = true)}
        onPointerLeave={() => (hoverRef.current = false)}
        onPointerDown={stop}
        onMouseDown={stop}
        onMouseUp={stop}
        onDblClick={stop}
        onContextMenu={stop}
      >
        <button
          type="button"
          class="fd-float-btn"
          data-state={state}
          title={label}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
        >
          <Icon name={state === "done" ? "check" : "download"} size={14} />
          <span class="fd-float-label">{state === "done" ? t("float.done") : label}</span>
        </button>
        {menuOpen ? (
          <div class={`fd-float-pop${flip ? " fd-flip" : ""}`} onClick={stop}>
            <QualityPicker
              rows={rows}
              onDone={() => {
                setMenuOpen(false);
                flash("done");
              }}
            >
              <button
                type="button"
                class="fd-qp-extra"
                onClick={() => {
                  setMenuOpen(false);
                  void sendAction({ action: "openPanel" }).catch(() => {});
                }}
              >
                {t("float.openPanel")}
              </button>
            </QualityPicker>
          </div>
        ) : null}
      </div>
      <ToastHost />
    </>
  );
}

/** 创建本帧浮钮控制器：首次出现可用的 video 元素时才真正挂载 Shadow DOM。 */
export function createFloatButton(deps: FloatButtonDeps): FloatButtonController {
  const { ctx, tracker } = deps;
  let config: PageConfig | null = null;
  let ui: ShadowRootContentScriptUi<HTMLElement> | null = null;
  let creating = false;
  let destroyed = false;
  let mountedContainer: HTMLElement | null = null;
  let mountedHost: HTMLElement | null = null;

  const wanted = (): boolean => !destroyed && config !== null && config.floatButton && config.sniff;
  const hasVideo = (): boolean => tracker.list().some((i) => i.tag === "video");

  /** 全屏元素包含目标视频（且不是视频本身）时，挂到全屏元素里才可见。 */
  function hostAnchor(): HTMLElement {
    const fs = fullscreenElementOf();
    if (fs && !isMediaTag(fs) && tracker.list().some((i) => fs.contains(i.el))) return fs as HTMLElement;
    return document.documentElement;
  }

  function draw(): void {
    if (mountedContainer && mountedHost && config) {
      render(<FloatRoot tracker={tracker} config={config} host={mountedHost} />, mountedContainer);
    }
  }

  async function ensure(): Promise<void> {
    if (ui || creating || !wanted() || !hasVideo()) return;
    creating = true;
    try {
      await initI18n();
      const created = await createShadowRootUi<HTMLElement>(ctx, {
        name: "fluxdown-float",
        position: "inline",
        anchor: () => hostAnchor(),
        append: "last",
        onMount(container, _shadow, host) {
          // 不能给宿主写定位样式：WXT 注入的 `:host{all:initial !important}` 属于 shadow 内层上下文，
          // 在 !important 级别压过宿主的内联样式（宿主恒为 static / z-index:auto）。
          // 定位与层级全部放在 shadow 内的 .fd-float-wrap（position:fixed + 最大 z-index）。
          mountedContainer = container;
          mountedHost = host;
          draw();
          return container;
        },
        onRemove(container) {
          if (container) render(null, container);
          mountedContainer = null;
          mountedHost = null;
        },
      });
      if (!wanted()) return;
      ui = created;
      ui.mount();
    } catch (e) {
      console.warn("[FluxDown] float button mount failed:", e);
    } finally {
      creating = false;
    }
  }

  function teardown(): void {
    if (!ui) return;
    ui.remove();
    ui = null;
  }

  const unsubscribe = tracker.subscribe(() => {
    if (!ui) void ensure();
  });

  const onFullscreenChange = (): void => {
    if (!ui) return;
    ui.remove();
    ui.mount();
  };
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);

  return {
    setConfig(next) {
      config = next;
      if (wanted()) {
        void ensure();
        draw();
      } else {
        teardown();
      }
    },
    destroy() {
      destroyed = true;
      unsubscribe();
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
      teardown();
    },
  };
}
