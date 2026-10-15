import type { ComponentChildren, JSX } from "preact";
import { useState } from "preact/hooks";
import type { ResourceType, RuleStage, SniffRuleV1 } from "@/rules/schema";
import { Button } from "@/ui/components/Button";
import { Modal } from "@/ui/components/Modal";
import { Select } from "@/ui/components/Select";
import { Tabs } from "@/ui/components/Tabs";
import { TagInput } from "@/ui/components/TagInput";
import { TextInput } from "@/ui/components/TextInput";
import { useT } from "@/ui/i18n";
import { isRecord } from "../../lib/guards";
import {
  REQUEST_TYPE_OPTIONS,
  RESOURCE_TYPE_OPTIONS,
  emptyForm,
  finalizeLocalRule,
  formToRule,
  generateRuleId,
  normalizeHostPattern,
  normalizeRuleExt,
  ruleTemplate,
  ruleToForm,
  type FormAction,
  type FormStage,
  type RuleForm,
} from "../../lib/rule-form";

interface RuleEditorModalProps {
  /** 正在编辑的已存规则；新建为 null。 */
  editing: SniffRuleV1 | null;
  takenIds: ReadonlySet<string>;
  onSave: (rule: SniffRuleV1) => void;
  onClose: () => void;
}

type EditorMode = "form" | "json";
type EditorStage = RuleStage;

function Field(props: { label: string; hint?: string; children?: ComponentChildren }): JSX.Element {
  return (
    <div class="opt-field">
      <span class="opt-field-label">{props.label}</span>
      {props.children}
      {props.hint ? <span class="opt-field-hint">{props.hint}</span> : null}
    </div>
  );
}

export function RuleEditorModal(props: RuleEditorModalProps): JSX.Element {
  const t = useT();
  const { editing } = props;

  // 初始：能用表单表示的规则走表单，否则（含 body / dom / 高级字段）直接进 JSON。
  const initialForm = editing ? ruleToForm(editing) : emptyForm();
  const [mode, setMode] = useState<EditorMode>(initialForm ? "form" : "json");
  const [form, setForm] = useState<RuleForm>(initialForm ?? emptyForm());
  const [jsonText, setJsonText] = useState(initialForm ? "" : JSON.stringify(editing, null, 2));
  const [errors, setErrors] = useState<string[]>([]);
  const [valid, setValid] = useState(false);

  const patch = (next: Partial<RuleForm>) => {
    setForm({ ...form, ...next });
    setValid(false);
  };

  const base = () => ({
    id: editing?.id ?? generateRuleId(form.title, Date.now()),
    version: editing?.version ?? 1,
    enabled: editing?.enabled,
    priority: editing?.priority,
  });

  const stageLabels: Record<EditorStage, string> = {
    response: t("rules.stage.response"),
    normalize: t("rules.stage.normalize"),
    track: t("rules.stage.track"),
    body: t("rules.stage.body"),
    dom: t("rules.stage.dom"),
  };

  /** 当前表单 / JSON 对应的草稿对象；解析失败返回错误文案。 */
  const readDraft = (): { ok: true; draft: unknown } | { ok: false; errors: string[] } => {
    if (mode === "form") {
      const result = formToRule(form, base());
      return result.ok ? { ok: true, draft: result.rule } : { ok: false, errors: [t(result.errorKey)] };
    }
    try {
      return { ok: true, draft: JSON.parse(jsonText) };
    } catch (e) {
      return { ok: false, errors: [t("rules.editor.jsonSyntax", { message: e instanceof Error ? e.message : String(e) })] };
    }
  };

  /** 校验当前草稿；通过返回定型后的规则。 */
  const validate = (): SniffRuleV1 | null => {
    const draft = readDraft();
    if (!draft.ok) {
      setErrors(draft.errors);
      setValid(false);
      return null;
    }
    const result = finalizeLocalRule(draft.draft, { editing, takenIds: props.takenIds, now: Date.now() });
    if (!result.ok) {
      setErrors(result.errors);
      setValid(false);
      return null;
    }
    setErrors([]);
    setValid(true);
    return result.rule;
  };

  const switchMode = (next: EditorMode) => {
    if (next === mode) return;
    setErrors([]);
    setValid(false);
    if (next === "json") {
      const result = formToRule(form, base());
      // 表单尚不完整时用模板兜底，保留已填标题。
      const draft = result.ok ? result.rule : { ...ruleTemplate(form.stage, base().id), title: form.title.trim() || undefined };
      setJsonText(JSON.stringify(draft, null, 2));
      setMode("json");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      setErrors([t("rules.editor.jsonSyntax", { message: e instanceof Error ? e.message : String(e) })]);
      return;
    }
    // ruleToForm 只读取 match / action 等结构，先确认这两处是对象再交给它判断。
    const convertible = isRecord(parsed) && isRecord(parsed.match) && isRecord(parsed.action);
    const candidate = convertible ? ruleToForm(parsed as unknown as SniffRuleV1) : null;
    if (!candidate) {
      setErrors([t("rules.editor.notFormCompatible")]);
      return;
    }
    setForm(candidate);
    setMode("form");
  };

  const changeStage = (stage: EditorStage) => {
    if (stage === "body" || stage === "dom" || stage === "track") {
      // 这些 stage 只能写 JSON：以模板为起点切换模式。
      setJsonText(JSON.stringify({ ...ruleTemplate(stage, base().id), title: form.title.trim() || undefined }, null, 2));
      setMode("json");
      setErrors([]);
      setValid(false);
      return;
    }
    const action: FormAction = stage === "response" ? "resource" : "filename";
    patch({ stage: stage as FormStage, action, params: [] });
  };

  const save = () => {
    const rule = validate();
    if (rule) props.onSave(rule);
  };

  const toggleRequestType = (type: string, on: boolean) => {
    patch({ requestTypes: on ? [...form.requestTypes, type] : form.requestTypes.filter((x) => x !== type) });
  };

  return (
    <Modal
      title={editing ? t("rules.editor.editTitle") : t("rules.editor.newTitle")}
      onClose={props.onClose}
      width={680}
      footer={
        <>
          <Button onClick={props.onClose}>{t("options.cancel")}</Button>
          <Button onClick={validate}>{t("rules.editor.validate")}</Button>
          <Button variant="primary" onClick={save}>
            {t("options.save")}
          </Button>
        </>
      }
    >
      <Tabs<EditorMode>
        active={mode}
        onChange={switchMode}
        items={[
          { key: "form", label: t("rules.editor.modeForm") },
          { key: "json", label: t("rules.editor.modeJson") },
        ]}
      />

      <div class="opt-form opt-editor-body">
        {mode === "json" ? (
          <>
            <textarea
              class="opt-json"
              spellcheck={false}
              value={jsonText}
              onInput={(e) => {
                setJsonText(e.currentTarget.value);
                setValid(false);
              }}
            />
            <span class="opt-field-hint">{t("rules.editor.jsonHint")}</span>
          </>
        ) : (
          <>
            <Field label={t("rules.editor.title")}>
              <TextInput value={form.title} placeholder={t("rules.editor.titlePlaceholder")} onInput={(title) => patch({ title })} />
            </Field>
            <Field label={t("rules.editor.stage")} hint={t("rules.editor.stageHint")}>
              <Select<EditorStage>
                value={form.stage}
                onChange={changeStage}
                options={[
                  { value: "response", label: stageLabels.response },
                  { value: "normalize", label: stageLabels.normalize },
                  { value: "body", label: stageLabels.body },
                  { value: "dom", label: stageLabels.dom },
                ]}
              />
            </Field>

            <h3 class="opt-subtitle">{t("rules.editor.match")}</h3>
            <Field label={t("rules.editor.host")} hint={t("rules.editor.hostHint")}>
              <TagInput tags={form.host} normalize={normalizeHostPattern} placeholder="example.com" onChange={(host) => patch({ host })} />
            </Field>
            <Field label={t("rules.editor.pageHost")} hint={t("rules.editor.pageHostHint")}>
              <TagInput
                tags={form.pageHost}
                normalize={normalizeHostPattern}
                placeholder="example.com"
                onChange={(pageHost) => patch({ pageHost })}
              />
            </Field>
            <Field label={t("rules.editor.url")} hint={t("rules.editor.urlHint")}>
              <TagInput tags={form.url} placeholder="*/video/*.m3u8*" onChange={(url) => patch({ url })} />
            </Field>
            <Field label={t("rules.editor.ext")} hint={t("rules.editor.extHint")}>
              <TagInput tags={form.ext} normalize={normalizeRuleExt} placeholder="mp4" onChange={(ext) => patch({ ext })} />
            </Field>
            <Field label={t("rules.editor.mime")} hint={t("rules.editor.mimeHint")}>
              <TagInput
                tags={form.mime}
                normalize={(raw) => raw.trim().toLowerCase()}
                placeholder="video/*"
                onChange={(mime) => patch({ mime })}
              />
            </Field>
            <Field label={t("rules.editor.requestType")}>
              <div class="opt-chips">
                {REQUEST_TYPE_OPTIONS.map((type) => (
                  <label class="opt-chip" key={type}>
                    <input
                      type="checkbox"
                      checked={form.requestTypes.includes(type)}
                      onChange={(e) => toggleRequestType(type, e.currentTarget.checked)}
                    />
                    {type}
                  </label>
                ))}
              </div>
            </Field>
            <div class="opt-field-row">
              <Field label={t("rules.editor.minSize")}>
                <TextInput type="number" min={0} value={form.minSizeMB} placeholder="MB" onInput={(minSizeMB) => patch({ minSizeMB })} />
              </Field>
              <Field label={t("rules.editor.maxSize")}>
                <TextInput type="number" min={0} value={form.maxSizeMB} placeholder="MB" onInput={(maxSizeMB) => patch({ maxSizeMB })} />
              </Field>
            </div>

            <h3 class="opt-subtitle">{t("rules.editor.action")}</h3>
            {form.stage === "response" ? (
              <>
                <Field label={t("rules.editor.action")}>
                  <Select<FormAction>
                    value={form.action}
                    onChange={(action) => patch({ action })}
                    options={[
                      { value: "resource", label: t("rules.editor.actResource") },
                      { value: "ignore", label: t("rules.editor.actIgnore") },
                    ]}
                  />
                </Field>
                {form.action === "resource" ? (
                  <Field label={t("rules.editor.resourceType")}>
                    <Select<ResourceType>
                      value={form.resourceType}
                      onChange={(resourceType) => patch({ resourceType })}
                      options={RESOURCE_TYPE_OPTIONS.map((value) => ({ value, label: value }))}
                    />
                  </Field>
                ) : null}
              </>
            ) : (
              <>
                <Field label={t("rules.editor.action")}>
                  <Select<FormAction>
                    value={form.action}
                    onChange={(action) => patch({ action })}
                    options={[
                      { value: "filename", label: t("rules.editor.actFilename") },
                      { value: "strip-params", label: t("rules.editor.actStrip") },
                    ]}
                  />
                </Field>
                <Field
                  label={t("rules.editor.params")}
                  hint={form.action === "filename" ? t("rules.editor.paramsFilenameHint") : t("rules.editor.paramsStripHint")}
                >
                  <TagInput tags={form.params} placeholder="format" onChange={(params) => patch({ params })} />
                </Field>
              </>
            )}
          </>
        )}

        {errors.length > 0 ? (
          <div class="opt-warn" role="alert">
            <strong>{t("rules.editor.errors")}</strong>
            <ul>
              {errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {valid ? <div class="opt-ok">{t("rules.editor.valid")}</div> : null}
      </div>
    </Modal>
  );
}
