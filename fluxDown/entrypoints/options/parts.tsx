/** options 各面板共用的版式组件。 */
import type { ComponentChildren, JSX } from "preact";
import { Button } from "@/ui/components/Button";
import { Modal } from "@/ui/components/Modal";
import { Toggle } from "@/ui/components/Toggle";
import { useT } from "@/ui/i18n";

export function PanelShell(props: { title: string; desc?: string; children?: ComponentChildren }): JSX.Element {
  return (
    <section class="opt-panel">
      <h1 class="opt-panel-title">{props.title}</h1>
      {props.desc ? <p class="opt-panel-desc">{props.desc}</p> : null}
      {props.children}
    </section>
  );
}

interface SettingRowProps {
  title: string;
  desc?: string;
  /** 说明下方的补充提示（强调色）。 */
  note?: string;
  /** 堆叠布局：说明在上、控件在下（列表类内容较宽）。 */
  stack?: boolean;
  /** 控件横向靠右排列（开关 / 按钮）。 */
  inline?: boolean;
  children?: ComponentChildren;
}

export function SettingRow(props: SettingRowProps): JSX.Element {
  return (
    <div class={`opt-row${props.stack ? " opt-row-stack" : ""}`}>
      <div class="opt-row-info">
        <div class="opt-row-title">{props.title}</div>
        {props.desc ? <div class="opt-row-desc">{props.desc}</div> : null}
        {props.note ? <div class="opt-row-desc opt-row-note">{props.note}</div> : null}
      </div>
      <div class={props.stack ? "opt-row-wide" : `opt-row-control${props.inline ? " opt-row-control-inline" : ""}`}>
        {props.children}
      </div>
    </div>
  );
}

interface ToggleRowProps {
  title: string;
  desc?: string;
  note?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function ToggleRow(props: ToggleRowProps): JSX.Element {
  return (
    <SettingRow title={props.title} desc={props.desc} note={props.note} inline>
      <Toggle checked={props.checked} onChange={props.onChange} disabled={props.disabled} label={props.title} />
    </SettingRow>
  );
}

interface ConfirmModalProps {
  title: string;
  message: ComponentChildren;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal(props: ConfirmModalProps): JSX.Element {
  const t = useT();
  return (
    <Modal
      title={props.title}
      onClose={props.onCancel}
      width={440}
      footer={
        <>
          <Button onClick={props.onCancel}>{t("options.cancel")}</Button>
          <Button variant={props.danger ? "danger" : "primary"} onClick={props.onConfirm}>
            {props.confirmLabel}
          </Button>
        </>
      }
    >
      <div class="opt-confirm">{props.message}</div>
    </Modal>
  );
}
