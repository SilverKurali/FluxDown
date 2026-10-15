import type { ComponentChildren, JSX } from "preact";
import { useEffect } from "preact/hooks";
import { IconButton } from "./IconButton";
import "./components.css";

interface ModalProps {
  title: string;
  onClose: () => void;
  children?: ComponentChildren;
  footer?: ComponentChildren;
  width?: number;
}

export function Modal(props: ModalProps): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.onClose]);
  return (
    <div
      class="fd-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="fd-modal" role="dialog" aria-modal="true" style={props.width ? { width: `${props.width}px` } : undefined}>
        <div class="fd-modal-head">
          <span class="fd-modal-title">{props.title}</span>
          <IconButton icon="close" label="×" onClick={props.onClose} />
        </div>
        <div class="fd-modal-body">{props.children}</div>
        {props.footer ? <div class="fd-modal-foot">{props.footer}</div> : null}
      </div>
    </div>
  );
}
