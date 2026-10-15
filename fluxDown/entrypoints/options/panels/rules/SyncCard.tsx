import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { RuleDocSummary, RuleSyncStatus } from "@/background/protocol";
import { Button } from "@/ui/components/Button";
import { Icon } from "@/ui/components/Icon";
import { showToast } from "@/ui/components/Toast";
import { Toggle } from "@/ui/components/Toggle";
import { useT } from "@/ui/i18n";
import { sendAction } from "@/utils/messaging";
import { settings, updateSettings } from "../../lib/store";

interface SyncCardProps {
  sync: RuleSyncStatus | null;
  onSynced: (status: RuleSyncStatus) => void;
}

/** ISO 时间 → 本地化显示；无法解析时原样返回。 */
function formatIso(iso: string | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toLocaleString();
}

export function SyncCard(props: SyncCardProps): JSX.Element | null {
  const t = useT();
  const s = settings.value;
  const [syncing, setSyncing] = useState(false);
  if (!s) return null;

  const { sync } = props;
  const syncNow = async () => {
    setSyncing(true);
    try {
      const status = await sendAction<"rulesSyncNow">({ action: "rulesSyncNow" });
      props.onSynced(status);
      showToast(status.lastError ? t("rules.sync.failed") : t("rules.sync.done"), status.lastError ? "error" : "success");
    } catch (e) {
      console.error("[FluxDown Options] rulesSyncNow failed:", e);
      showToast(t("rules.sync.failed"), "error");
    } finally {
      setSyncing(false);
    }
  };

  const docs: [string, RuleDocSummary | null | undefined][] = [
    [t("rules.sync.official"), sync?.official],
    [t("rules.sync.community"), sync?.community],
    [t("rules.sync.revocations"), sync?.revocations],
  ];
  const lastError = sync?.lastError ?? sync?.host?.lastError ?? null;
  const hostFetch = sync?.host?.lastFetchUnix;

  return (
    <div class="opt-card">
      <div class="opt-card-head">
        <h2 class="opt-card-title">{t("rules.sync.title")}</h2>
        <Button variant="primary" size="sm" disabled={syncing} onClick={() => void syncNow()}>
          <Icon name="refresh" size={13} />
          {syncing ? t("rules.sync.syncing") : t("rules.sync.now")}
        </Button>
      </div>

      <table class="opt-table opt-table-compact">
        <thead>
          <tr>
            <th>{t("rules.sync.colPack")}</th>
            <th>{t("rules.sync.colSequence")}</th>
            <th>{t("rules.sync.colIssued")}</th>
            <th>{t("rules.sync.colExpires")}</th>
          </tr>
        </thead>
        <tbody>
          {docs.map(([label, doc]) => (
            <tr key={label}>
              <td>{label}</td>
              <td class="opt-cell-mono">{doc ? doc.sequence : "—"}</td>
              <td>{doc ? formatIso(doc.issuedAt) : t("rules.sync.none")}</td>
              <td>{doc ? formatIso(doc.expiresAt) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl class="opt-kv">
        <dt>{t("rules.sync.lastSync")}</dt>
        <dd>{sync?.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleString() : t("rules.sync.never")}</dd>
        {hostFetch ? (
          <>
            <dt>{t("rules.sync.hostFetch")}</dt>
            <dd>{new Date(hostFetch * 1000).toLocaleString()}</dd>
          </>
        ) : null}
        <dt>{t("rules.sync.lastError")}</dt>
        <dd class={lastError ? "opt-error-text" : ""}>{lastError ?? t("rules.sync.noError")}</dd>
      </dl>

      <div class="opt-card-toggles">
        <label class="opt-inline-toggle">
          <Toggle
            checked={s.ruleSyncEnabled}
            label={t("rules.sync.enabled")}
            onChange={(v) => void updateSettings({ ruleSyncEnabled: v })}
          />
          <span>
            <strong>{t("rules.sync.enabled")}</strong>
            <span class="opt-row-desc">{t("rules.sync.enabledDesc")}</span>
          </span>
        </label>
        <label class="opt-inline-toggle">
          <Toggle
            checked={s.communityRulesEnabled}
            label={t("rules.sync.communityEnabled")}
            onChange={(v) => void updateSettings({ communityRulesEnabled: v })}
          />
          <span>
            <strong>{t("rules.sync.communityEnabled")}</strong>
            <span class="opt-row-desc">{t("rules.sync.communityEnabledDesc")}</span>
          </span>
        </label>
      </div>
    </div>
  );
}
