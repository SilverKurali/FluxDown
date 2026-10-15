import type { JSX } from "preact";
import { Select } from "@/ui/components/Select";
import { useT } from "@/ui/i18n";
import { settings, updateSettings } from "../lib/store";
import { PanelShell, SettingRow, ToggleRow } from "../parts";

export function SniffPanel(): JSX.Element | null {
  const t = useT();
  const s = settings.value;
  if (!s) return null;

  return (
    <PanelShell title={t("options.nav.sniff")}>
      <ToggleRow
        title={t("options.sniff.enabled")}
        desc={t("options.sniff.enabledDesc")}
        checked={s.resourceSniffing}
        onChange={(v) => void updateSettings({ resourceSniffing: v })}
      />
      <ToggleRow
        title={t("options.sniff.pageDot")}
        desc={t("options.sniff.pageDotDesc")}
        checked={s.showPageDot}
        onChange={(v) => void updateSettings({ showPageDot: v })}
      />
      <ToggleRow
        title={t("options.sniff.floatButton")}
        desc={t("options.sniff.floatButtonDesc")}
        checked={s.showFloatingButton}
        onChange={(v) => void updateSettings({ showFloatingButton: v })}
      />
      <SettingRow title={t("options.sniff.floatTrigger")} desc={t("options.sniff.floatTriggerDesc")}>
        <Select<"hover" | "always">
          value={s.floatButtonTrigger}
          disabled={!s.showFloatingButton}
          onChange={(v) => void updateSettings({ floatButtonTrigger: v })}
          options={[
            { value: "hover", label: t("options.sniff.triggerHover") },
            { value: "always", label: t("options.sniff.triggerAlways") },
          ]}
        />
      </SettingRow>
      <ToggleRow
        title={t("options.sniff.images")}
        desc={t("options.sniff.imagesDesc")}
        checked={s.sniffImages}
        onChange={(v) => void updateSettings({ sniffImages: v })}
      />
      <ToggleRow
        title={t("options.sniff.lowConfidence")}
        desc={t("options.sniff.lowConfidenceDesc")}
        checked={s.showLowConfidence}
        onChange={(v) => void updateSettings({ showLowConfidence: v })}
      />
    </PanelShell>
  );
}
