import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import type { RuleOverrides, SniffRuleV1 } from "@/rules/schema";
import { Button } from "@/ui/components/Button";
import { EmptyState } from "@/ui/components/EmptyState";
import { IconButton } from "@/ui/components/IconButton";
import { showToast } from "@/ui/components/Toast";
import { useT } from "@/ui/i18n";
import { downloadJson } from "../../lib/download";
import { buildLocalPack, mergeImported, parseLocalPack } from "../../lib/local-rules";
import { ConfirmModal } from "../../parts";
import { RuleEditorModal } from "./RuleEditorModal";

interface LocalRulesProps {
  rules: SniffRuleV1[];
  overrides: RuleOverrides;
  onRulesChange: (next: SniffRuleV1[]) => void;
  onOverridesChange: (next: RuleOverrides) => void;
}

interface ImportReport {
  added: number;
  replaced: number;
  rejected: { id: string; reason: string }[];
}

type EditorTarget = { rule: SniffRuleV1 | null } | null;

export function LocalRules(props: LocalRulesProps): JSX.Element {
  const t = useT();
  const fileInput = useRef<HTMLInputElement>(null);
  const [editor, setEditor] = useState<EditorTarget>(null);
  const [removing, setRemoving] = useState<SniffRuleV1 | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);

  const stageLabels: Record<string, string> = {
    response: t("rules.stage.response"),
    normalize: t("rules.stage.normalize"),
    track: t("rules.stage.track"),
    body: t("rules.stage.body"),
    dom: t("rules.stage.dom"),
  };

  const saveRule = (rule: SniffRuleV1) => {
    const exists = props.rules.some((r) => r.id === rule.id);
    props.onRulesChange(exists ? props.rules.map((r) => (r.id === rule.id ? rule : r)) : [...props.rules, rule]);
    setEditor(null);
    showToast(t("rules.local.saved"), "success");
  };

  const removeRule = (rule: SniffRuleV1) => {
    props.onRulesChange(props.rules.filter((r) => r.id !== rule.id));
    if (rule.id in props.overrides) {
      const { [rule.id]: _removed, ...rest } = props.overrides;
      props.onOverridesChange(rest);
    }
    setRemoving(null);
  };

  const exportRules = () => {
    downloadJson(`fluxdown-local-rules-${new Date().toISOString().slice(0, 10)}.json`, buildLocalPack(props.rules, Date.now()));
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    const parsed = parseLocalPack(await file.text());
    if (!parsed.ok) {
      showToast(t("rules.local.importInvalid", { message: parsed.error }), "error");
      return;
    }
    const merged = mergeImported(props.rules, parsed.accepted);
    props.onRulesChange(merged.rules);
    setReport({ added: merged.added, replaced: merged.replaced, rejected: parsed.rejected });
  };

  return (
    <div class="opt-card">
      <div class="opt-card-head">
        <h2 class="opt-card-title">{t("rules.local.title")}</h2>
        <div class="opt-filters">
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            class="fd-hidden"
            onChange={(e) => {
              const input = e.currentTarget;
              void importFile(input.files?.[0]).finally(() => {
                input.value = "";
              });
            }}
          />
          <Button size="sm" onClick={() => fileInput.current?.click()}>
            {t("rules.local.import")}
          </Button>
          <Button size="sm" disabled={props.rules.length === 0} onClick={exportRules}>
            {t("rules.local.export")}
          </Button>
          <Button size="sm" variant="primary" onClick={() => setEditor({ rule: null })}>
            {t("rules.local.new")}
          </Button>
        </div>
      </div>
      <p class="opt-row-desc">{t("rules.local.desc")}</p>

      {report ? (
        <div class={report.rejected.length > 0 ? "opt-warn" : "opt-ok"}>
          <div>{t("rules.local.importDone", { added: String(report.added), replaced: String(report.replaced) })}</div>
          {report.rejected.length > 0 ? (
            <>
              <strong>{t("rules.local.importRejected", { count: String(report.rejected.length) })}</strong>
              <ul>
                {report.rejected.map((r) => (
                  <li key={r.id + r.reason}>
                    <code>{r.id || "?"}</code> {r.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setReport(null)}>
            {t("rules.local.dismiss")}
          </Button>
        </div>
      ) : null}

      {props.rules.length === 0 ? (
        <EmptyState icon="plus" title={t("rules.local.empty")} hint={t("rules.local.emptyHint")} />
      ) : (
        <div class="opt-table-wrap">
          <table class="opt-table">
            <thead>
              <tr>
                <th>{t("rules.table.colRule")}</th>
                <th>{t("rules.table.colStage")}</th>
                <th>{t("rules.table.colVersion")}</th>
                <th class="opt-col-actions">{t("options.sites.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {props.rules.map((rule) => (
                <tr key={rule.id}>
                  <td>
                    <div class="opt-rule-title">{rule.title || rule.id}</div>
                    {rule.title ? <div class="opt-cell-mono opt-rule-id">{rule.id}</div> : null}
                  </td>
                  <td>{stageLabels[rule.stage] ?? rule.stage}</td>
                  <td class="opt-cell-mono">{rule.version}</td>
                  <td class="opt-col-actions">
                    <IconButton icon="edit" label={t("rules.local.edit")} onClick={() => setEditor({ rule })} />
                    <IconButton icon="trash" label={t("rules.local.remove")} onClick={() => setRemoving(rule)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editor ? (
        <RuleEditorModal
          editing={editor.rule}
          takenIds={new Set(props.rules.map((r) => r.id))}
          onSave={saveRule}
          onClose={() => setEditor(null)}
        />
      ) : null}

      {removing ? (
        <ConfirmModal
          title={t("rules.local.remove")}
          message={t("rules.local.removeConfirm", { name: removing.title || removing.id })}
          confirmLabel={t("rules.local.remove")}
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => removeRule(removing)}
        />
      ) : null}
    </div>
  );
}
