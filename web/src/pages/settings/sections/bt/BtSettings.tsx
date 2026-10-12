// BitTorrent：基础（DHT/UPnP/端口）、Tracker（列表 + 订阅）、做种（GPUI `sections/bt.rs`）。

import { useT } from '../../../../i18n'
import {
  DaemonEnumRow,
  DaemonNumberRow,
  DaemonSwitchRow,
  DropdownField,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  setDaemon,
  useDaemonBool,
  useDaemonValue,
} from '../../kit'
import { ListEditorRow, SubscriptionStatusRow } from '../subscription'

function BasicTab({ btEnabled }: { btEnabled: boolean }) {
  const t = useT()
  return (
    <SettingsSection title={t('settingsTabGeneral')} subtitle={t('btSettingsRestartHint')}>
      <DaemonSwitchRow configKey="bt_enabled" titleKey="btEnabled" descKey="btEnabledDesc" />
      {btEnabled ? (
        <>
          <DaemonSwitchRow configKey="bt_enable_dht" titleKey="btEnableDht" descKey="btEnableDhtDesc" />
          <DaemonSwitchRow configKey="bt_enable_upnp" titleKey="btEnableUpnp" descKey="btEnableUpnpDesc" />
          <DaemonSwitchRow configKey="bt_enable_utp" titleKey="btEnableUtp" descKey="btEnableUtpDesc" />
          <DaemonNumberRow configKey="bt_port_start" titleKey="btListenPortStart" descKey="btListenPortDesc" />
          <DaemonNumberRow configKey="bt_port_end" titleKey="btListenPortEnd" />
          <DaemonEnumRow configKey="bt_mse_mode" titleKey="btMseMode" descKey="btMseModeDesc" labelPrefix="btMseMode" />
        </>
      ) : null}
    </SettingsSection>
  )
}

function TrackerTab() {
  const t = useT()
  const subEnabled = useDaemonBool('bt_tracker_sub_enabled')
  return (
    <SettingsSection title={t('settingsTabTracker')}>
      <ListEditorRow configKey="bt_custom_trackers" titleKey="btTrackerList" descKey="btTrackerListDesc" placeholderKey="btTrackerPlaceholder" format="lines" />
      <DaemonSwitchRow configKey="bt_tracker_sub_enabled" titleKey="btTrackerSub" descKey="btTrackerSubDesc" />
      <ListEditorRow
        configKey="bt_tracker_sub_urls"
        titleKey="btTrackerSubUrls"
        descKey="btTrackerSubUrlsDesc"
        placeholderKey="btTrackerSubPlaceholder"
        format="lines"
        disabled={!subEnabled}
      />
      <SubscriptionStatusRow kind="btTrackers" />
    </SettingsSection>
  )
}

function ThenActionRow() {
  const t = useT()
  const value = useDaemonValue('bt_seed_then_action')
  const options = [
    { value: 'stop', label: t('btSeedStopSeeding') },
    { value: 'delete', label: t('btSeedDeleteTask') },
    { value: 'delete_files', label: t('btSeedDeleteTaskAndFiles') },
  ]
  const title = t('btSeedThenAction')
  return (
    <SettingsRow title={title}>
      <DropdownField value={value} options={options} aria-label={title} onValueChange={(next) => setDaemon('bt_seed_then_action', next)} />
    </SettingsRow>
  )
}

function SeedingTab() {
  const t = useT()
  const seedEnabled = useDaemonBool('bt_seed_enabled')
  const operatorOptions = [
    { value: 'or', label: t('btSeedOperatorOr') },
    { value: 'and', label: t('btSeedOperatorAnd') },
  ]
  const operator = useDaemonValue('bt_seed_limit_operator')
  return (
    <SettingsSection title={t('settingsTabSeeding')}>
      <DaemonSwitchRow configKey="bt_seed_enabled" titleKey="btSeedEnabled" descKey="btSeedEnabledDesc" />
      {seedEnabled ? (
        <>
          <DaemonNumberRow configKey="bt_seed_max_active" titleKey="btSeedMaxActive" descKey="btSeedMaxActiveDesc" />
          <DaemonSwitchRow configKey="bt_auto_reseed" titleKey="btAutoReseed" descKey="btAutoReseedDesc" />
          <DaemonNumberRow configKey="bt_seed_ratio_limit" titleKey="btSeedRatioLimit" step={0.1} />
          <DaemonNumberRow configKey="bt_seed_post_ratio_limit" titleKey="btSeedPostRatioLimit" step={0.1} />
          <DaemonNumberRow configKey="bt_seed_time_limit_minutes" titleKey="btSeedTimeLimit" />
          <DaemonEnumRow configKey="bt_seed_time_limit_unit" titleKey="btSeedTimeLimitUnit" labelPrefix="timeUnit" />
          <DaemonNumberRow configKey="bt_seed_inactive_time_limit_minutes" titleKey="btSeedInactiveTimeLimit" />
          <DaemonEnumRow configKey="bt_seed_inactive_time_limit_unit" titleKey="btSeedInactiveTimeLimitUnit" labelPrefix="timeUnit" />
          <SettingsRow title={t('btSeedConditionsOperator')}>
            <DropdownField
              value={operator}
              options={operatorOptions}
              aria-label={t('btSeedConditionsOperator')}
              onValueChange={(next) => setDaemon('bt_seed_limit_operator', next)}
            />
          </SettingsRow>
          <ThenActionRow />
        </>
      ) : null}
    </SettingsSection>
  )
}

export function BtSettings() {
  const t = useT()
  const btEnabled = useDaemonBool('bt_enabled')
  const tabs = [
    { id: 'basic', label: t('settingsTabGeneral'), content: <BasicTab btEnabled={btEnabled} /> },
  ]
  if (btEnabled) {
    tabs.push(
      { id: 'tracker', label: t('settingsTabTracker'), content: <TrackerTab /> },
      { id: 'seeding', label: t('settingsTabSeeding'), content: <SeedingTab /> },
    )
  }
  return (
    <SettingsPage
      title={t('settingsCatBt')}
      description={t('settingsCatBtDesc')}
      tabs={tabs}
    />
  )
}
