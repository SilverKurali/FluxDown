import type { JSX } from "preact";
import { useT } from "@/ui/i18n";
import {
  LOCAL_RULES_KEY,
  RULE_OVERRIDES_KEY,
  parseLocalRules,
  parseOverrides,
} from "../../lib/local-rules";
import { useLocalValue } from "../../lib/store";
import { PanelShell } from "../../parts";
import { LocalRules } from "./LocalRules";
import { RuleTable } from "./RuleTable";
import { RuleTester } from "./RuleTester";
import { SyncCard } from "./SyncCard";
import { useRulesData } from "./useRulesData";

export function RulesPanel(): JSX.Element {
  const t = useT();
  const data = useRulesData();
  const [overrides, writeOverrides] = useLocalValue(RULE_OVERRIDES_KEY, parseOverrides);
  const [localRules, writeLocalRules] = useLocalValue(LOCAL_RULES_KEY, parseLocalRules);

  return (
    <PanelShell title={t("options.nav.rules")} desc={t("rules.desc")}>
      {data.loadError ? (
        <div class="opt-warn" role="alert">
          {t("rules.loadError", { message: data.loadError })}
        </div>
      ) : null}
      <SyncCard sync={data.sync} onSynced={data.setSync} />
      <RuleTable
        entries={data.entries}
        overrides={overrides}
        revocationSequence={data.sync?.revocations?.sequence ?? null}
        onOverridesChange={(next) => void writeOverrides(next)}
      />
      <LocalRules
        rules={localRules}
        overrides={overrides}
        onRulesChange={(next) => void writeLocalRules(next)}
        onOverridesChange={(next) => void writeOverrides(next)}
      />
      <RuleTester />
    </PanelShell>
  );
}
