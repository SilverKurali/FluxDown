import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { RulesTestResult } from "@/background/protocol";
import type { RuleRef } from "@/rules/engine";
import { Button } from "@/ui/components/Button";
import { Select } from "@/ui/components/Select";
import { showToast } from "@/ui/components/Toast";
import { TextInput } from "@/ui/components/TextInput";
import { Toggle } from "@/ui/components/Toggle";
import { useT } from "@/ui/i18n";
import { sendAction } from "@/utils/messaging";
import { REQUEST_TYPE_OPTIONS } from "../../lib/rule-form";

const MB = 1024 * 1024;

export function RuleTester(): JSX.Element {
  const t = useT();
  const [url, setUrl] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const [mime, setMime] = useState("");
  const [sizeMB, setSizeMB] = useState("");
  const [resourceType, setResourceType] = useState<string>("");
  const [attachment, setAttachment] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RulesTestResult | null>(null);

  const run = async () => {
    const target = url.trim();
    if (!target) {
      showToast(t("rules.test.urlRequired"), "error");
      return;
    }
    const mb = Number(sizeMB);
    setRunning(true);
    try {
      setResult(
        await sendAction<"rulesTest">({
          action: "rulesTest",
          url: target,
          pageUrl: pageUrl.trim() || target,
          resourceType: resourceType || undefined,
          mime: mime.trim() || undefined,
          // 留空 = 大小未知（-1）。
          size: sizeMB.trim() !== "" && Number.isFinite(mb) && mb >= 0 ? Math.round(mb * MB) : -1,
          attachment,
        }),
      );
    } catch (e) {
      console.error("[FluxDown Options] rulesTest failed:", e);
      showToast(t("rules.test.failed"), "error");
    } finally {
      setRunning(false);
    }
  };

  const describeRule = (rule: RuleRef): string => `${rule.id} (v${rule.version}, ${t(`rules.tier.${rule.tier}`)})`;

  let decision: string;
  const response = result?.response;
  if (response?.decision === "resource") {
    decision = t("rules.test.decisionResource", { type: response.type, rule: describeRule(response.rule) });
  } else if (response?.decision === "ignore") {
    decision = t("rules.test.decisionIgnore", { rule: describeRule(response.rule) });
  } else {
    decision = t("rules.test.decisionNone");
  }

  return (
    <div class="opt-card">
      <div class="opt-card-head">
        <h2 class="opt-card-title">{t("rules.test.title")}</h2>
      </div>
      <p class="opt-row-desc">{t("rules.test.desc")}</p>

      <div class="opt-form">
        <label class="opt-field">
          <span class="opt-field-label">{t("rules.test.url")}</span>
          <TextInput value={url} placeholder="https://cdn.example.com/video/clip.m3u8" onInput={setUrl} />
        </label>
        <label class="opt-field">
          <span class="opt-field-label">{t("rules.test.pageUrl")}</span>
          <TextInput value={pageUrl} placeholder={t("rules.test.pageUrlPlaceholder")} onInput={setPageUrl} />
        </label>
        <div class="opt-field-row">
          <label class="opt-field">
            <span class="opt-field-label">{t("rules.test.mime")}</span>
            <TextInput value={mime} placeholder="video/mp4" onInput={setMime} />
          </label>
          <label class="opt-field">
            <span class="opt-field-label">{t("rules.test.size")}</span>
            <TextInput type="number" min={0} value={sizeMB} placeholder={t("rules.test.sizePlaceholder")} onInput={setSizeMB} />
          </label>
        </div>
        <div class="opt-field-row">
          <div class="opt-field">
            <span class="opt-field-label">{t("rules.test.resourceType")}</span>
            <Select<string>
              value={resourceType}
              onChange={setResourceType}
              options={[
                { value: "", label: t("rules.test.resourceTypeAny") },
                ...REQUEST_TYPE_OPTIONS.map((value) => ({ value, label: value })),
              ]}
            />
          </div>
          <div class="opt-field opt-field-inline">
            <span class="opt-field-label">{t("rules.test.attachment")}</span>
            <Toggle checked={attachment} label={t("rules.test.attachment")} onChange={setAttachment} />
          </div>
        </div>
        <div>
          <Button variant="primary" disabled={running} onClick={() => void run()}>
            {t("rules.test.run")}
          </Button>
        </div>
      </div>

      {result ? (
        <dl class="opt-kv opt-test-result-box">
          <dt>{t("rules.test.resDecision")}</dt>
          <dd>{decision}</dd>
          <dt>{t("rules.test.resTrack")}</dt>
          <dd>{result.track ?? "—"}</dd>
          <dt>{t("rules.test.resDedupe")}</dt>
          <dd class="opt-cell-mono opt-cell-wrap">{result.dedupeKey || "—"}</dd>
          <dt>{t("rules.test.resExt")}</dt>
          <dd class="opt-cell-mono">{result.fileExtension || "—"}</dd>
        </dl>
      ) : null}
    </div>
  );
}
