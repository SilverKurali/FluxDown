/** 「交给桌面端解析」卡片：按 HandoffState 显示状态；仅 match 时给出按钮。 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { HandoffState } from "@/background/protocol";
import { sendAction } from "@/utils/messaging";
import { Button } from "@/ui/components/Button";
import { Icon } from "@/ui/components/Icon";
import { showToast } from "@/ui/components/Toast";
import { useT } from "@/ui/i18n";
import "./features.css";

export function HandoffCard(props: { handoff: HandoffState; tabId: number }): JSX.Element {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const h = props.handoff;

  const send = async () => {
    setBusy(true);
    try {
      const res = await sendAction<"handoffPage">({ action: "handoffPage", tabId: props.tabId });
      if (res?.success) showToast(t("handoff.sent"), "success");
      else showToast(res?.message || t("list.sendFailed"), "error");
    } catch {
      showToast(t("list.sendFailed"), "error");
    } finally {
      setBusy(false);
    }
  };

  let text: string;
  switch (h.kind) {
    case "unavailable":
      text = t(`handoff.unavailable.${h.reason}`);
      break;
    case "no-match":
      text = t("handoff.noMatch", { count: String(h.installed) });
      break;
    case "disabled":
      text = t("handoff.disabled", { name: h.name });
      break;
    case "match":
      text = t("handoff.match", { name: h.name });
      break;
  }

  return (
    <div class={`fd-handoff fd-handoff-${h.kind}`}>
      <Icon name="external" size={16} />
      <div class="fd-handoff-text">
        <div class="fd-handoff-title">{t("handoff.title")}</div>
        <div class="fd-handoff-desc">{text}</div>
      </div>
      {h.kind === "match" ? (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void send()}>
          {t("handoff.button")}
        </Button>
      ) : null}
    </div>
  );
}
