// 插件子页：已安装插件管理（启用 / 设置 / 登录 / 卸载）+ 安装区（zip 上传 / 服务端开发目录）+ 插件市场。

import { FolderOpen, Info, Package, RotateCw, Settings, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { useT } from '../../../../i18n'
import { METHOD, call, rpc, uploadBlob, useDaemon } from '../../../../lib/rpc'
import type { DaemonSnapshot, InstalledPlugin, PluginDto } from '../../../../lib/rpc'
import { Badge, Button, Card, ConfirmFooter, Dialog, EmptyState, FormField, Input, InputWithAction, Switch, confirmDialog, toast } from '../../../../ui'
import { BlockTitle, ExtLink, IconButton, ListCard, ListRow } from './common'
import { detailFromPlugin } from './detail'
import type { PluginDetail } from './detail'
import { extensionErrorText } from './errors'
import { MarketSection } from './MarketSection'
import { PluginAuthDialog } from './PluginAuthDialog'
import { PluginDetailDialog } from './PluginDetailDialog'
import { PluginSettingsDialog } from './PluginSettingsDialog'

const EMPTY_PLUGINS: PluginDto[] = []
const selectPlugins = (daemon: DaemonSnapshot) => daemon.plugins

/** 安装（解包 / 校验 / 加载）可能比默认 30s 更久。 */
const INSTALL_TIMEOUT_MS = 180_000

/** 组件线名 → 标题键（依赖提醒里显示组件名）。 */
const COMPONENT_TITLE_KEYS: Record<string, string> = {
  ffmpeg: 'componentsFfmpegTitle',
  ytdlp: 'componentsYtdlpTitle',
}

type ZipPhase = { kind: 'uploading'; fraction: number } | { kind: 'installing' } | null

export function PluginsTab({ stale, onGoToComponents }: { stale: boolean; onGoToComponents: () => void }) {
  const t = useT()
  const plugins = useDaemon(selectPlugins, EMPTY_PLUGINS)
  const [devMode, setDevMode] = useState(true)
  const [devDir, setDevDir] = useState('')
  const [installingDir, setInstallingDir] = useState(false)
  const [zipPhase, setZipPhase] = useState<ZipPhase>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [detail, setDetail] = useState<PluginDetail | null>(null)
  const [settingsPlugin, setSettingsPlugin] = useState<PluginDto | null>(null)
  const [authPlugin, setAuthPlugin] = useState<PluginDto | null>(null)
  const [missing, setMissing] = useState<string[] | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const onInstalled = (result: InstalledPlugin) => {
    toast.success(t('pluginOpInstallSuccess'))
    if (result.missingComponents?.length) setMissing(result.missingComponents)
  }
  const onInstallFailed = (error: unknown) => {
    toast.error(t('pluginOpInstallFailed', { message: extensionErrorText(t, error) }))
  }

  const withBusy = async (identity: string, action: () => Promise<void>) => {
    if (busy.has(identity)) return
    setBusy((current) => new Set(current).add(identity))
    try {
      await action()
    } finally {
      setBusy((current) => {
        const next = new Set(current)
        next.delete(identity)
        return next
      })
    }
  }

  const setEnabled = (plugin: PluginDto, enabled: boolean) =>
    withBusy(plugin.identity, async () => {
      try {
        await rpc.daemon.plugin.setEnabled({ identity: plugin.identity, enabled })
      } catch (error) {
        toast.error(t('pluginOpEnabledFailed', { message: extensionErrorText(t, error) }))
      }
    })

  const uninstall = async (plugin: PluginDto) => {
    const ok = await confirmDialog({
      title: t('pluginUninstallTitle'),
      description: t('pluginUninstallMsg', { name: plugin.name }),
      okLabel: t('pluginUninstallTooltip'),
      intent: 'destructive',
    })
    if (!ok) return
    await withBusy(plugin.identity, async () => {
      try {
        await rpc.daemon.plugin.uninstall({ identity: plugin.identity })
        toast.success(t('pluginOpUninstallSuccess'))
      } catch (error) {
        toast.error(t('pluginOpUninstallFailed', { message: extensionErrorText(t, error) }))
      }
    })
  }

  const reload = (plugin: PluginDto) =>
    withBusy(plugin.identity, async () => {
      try {
        const result = await rpc.daemon.plugin.reloadDev({ identity: plugin.identity })
        toast.success(t('pluginOpReloadSuccess'))
        if (result.missingComponents?.length) setMissing(result.missingComponents)
      } catch (error) {
        toast.error(t('pluginOpReloadFailed', { message: extensionErrorText(t, error) }))
      }
    })

  /** 浏览器选 zip → 上传 blob → `daemon.plugin.install {blobId}`。 */
  const installZip = async (file: File) => {
    if (zipPhase) return
    setZipPhase({ kind: 'uploading', fraction: 0 })
    try {
      const blobId = await uploadBlob('plugins', file, {
        onProgress: (fraction) => setZipPhase({ kind: 'uploading', fraction }),
      })
      setZipPhase({ kind: 'installing' })
      onInstalled(await call<InstalledPlugin>(METHOD.DAEMON_PLUGIN_INSTALL, { blobId }, { timeoutMs: INSTALL_TIMEOUT_MS }))
    } catch (error) {
      onInstallFailed(error)
    } finally {
      setZipPhase(null)
    }
  }

  const installDir = async () => {
    const dirPath = devDir.trim()
    if (dirPath === '' || installingDir) return
    setInstallingDir(true)
    try {
      onInstalled(await rpc.daemon.plugin.installDev({ dirPath }))
      setDevDir('')
    } catch (error) {
      onInstallFailed(error)
    } finally {
      setInstallingDir(false)
    }
  }

  const zipLabel =
    zipPhase?.kind === 'uploading'
      ? t('webPluginUploading', { percent: Math.round(zipPhase.fraction * 100) })
      : zipPhase?.kind === 'installing'
        ? t('marketInstallingButton')
        : t('pluginInstallZipButton')

  return (
    <div className="flex w-full flex-col gap-4">
      <BlockTitle
        title={t('pluginsSectionTitle')}
        trailing={
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            {t('pluginDevModeSwitch')}
            <Switch checked={devMode} onCheckedChange={setDevMode} aria-label={t('pluginDevModeSwitch')} />
          </label>
        }
      />

      <Card className="flex flex-col gap-4 p-3">
        <div>
          <input
            ref={fileInput}
            type="file"
            accept=".fxplug,.zip"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void installZip(file)
            }}
          />
          <Button variant="outline" icon={FolderOpen} loading={zipPhase !== null} disabled={stale} onClick={() => fileInput.current?.click()}>
            {zipLabel}
          </Button>
        </div>
        {devMode ? (
          <FormField label={t('pluginInstallDirLabel')} htmlFor="plugin-install-dir" hint={t('webPluginInstallDirHint')}>
            <InputWithAction
              input={
                <Input
                  id="plugin-install-dir"
                  value={devDir}
                  placeholder={t('pluginInstallDirPlaceholder')}
                  disabled={installingDir}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(event) => setDevDir(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void installDir()
                  }}
                />
              }
              action={
                <Button variant="primary" loading={installingDir} disabled={stale || devDir.trim() === ''} onClick={() => void installDir()}>
                  {t('pluginInstallDirButton')}
                </Button>
              }
            />
          </FormField>
        ) : null}
      </Card>

      {plugins.length === 0 ? (
        <EmptyState icon={Package} title={t('pluginsEmpty')} />
      ) : (
        <ListCard>
          {plugins.map((plugin) => (
            <PluginRow
              key={plugin.identity}
              plugin={plugin}
              disabled={stale || busy.has(plugin.identity)}
              onDetail={() => setDetail(detailFromPlugin(plugin))}
              onSettings={() => setSettingsPlugin(plugin)}
              onAuth={() => setAuthPlugin(plugin)}
              onUninstall={() => void uninstall(plugin)}
              onReload={() => void reload(plugin)}
              onToggle={(enabled) => void setEnabled(plugin, enabled)}
            />
          ))}
        </ListCard>
      )}

      <MarketSection stale={stale} plugins={plugins} onInstalled={onInstalled} onInstallFailed={onInstallFailed} onShowDetail={setDetail} />

      <PluginDetailDialog detail={detail} onClose={() => setDetail(null)} />
      <PluginSettingsDialog plugin={settingsPlugin} onClose={() => setSettingsPlugin(null)} />
      <PluginAuthDialog plugin={authPlugin} onClose={() => setAuthPlugin(null)} />
      <Dialog
        open={missing !== null}
        onOpenChange={(open) => !open && setMissing(null)}
        title={t('pluginDepsMissingTitle')}
        description={
          missing
            ? t('pluginDepsMissingBody', {
                components: missing.map((name) => (COMPONENT_TITLE_KEYS[name] ? t(COMPONENT_TITLE_KEYS[name]) : name)).join(', '),
              })
            : undefined
        }
        size="sm"
        footer={
          <ConfirmFooter
            cancelLabel={t('pluginDepsLater')}
            okLabel={t('pluginDepsGoToComponents')}
            onCancel={() => setMissing(null)}
            onOk={() => {
              setMissing(null)
              onGoToComponents()
            }}
          />
        }
      />
    </div>
  )
}

function PluginRow({
  plugin,
  disabled,
  onDetail,
  onSettings,
  onAuth,
  onUninstall,
  onReload,
  onToggle,
}: {
  plugin: PluginDto
  disabled: boolean
  onDetail: () => void
  onSettings: () => void
  onAuth: () => void
  onUninstall: () => void
  onReload: () => void
  onToggle: (enabled: boolean) => void
}) {
  const t = useT()
  const loadFailed = plugin.loadStatus === 'Failed'
  return (
    <ListRow
      info={
        <>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 break-words text-sm font-medium text-foreground">{plugin.name}</span>
            <span className="tabular text-xs text-muted-foreground">v{plugin.version}</span>
            {plugin.devMode ? <Badge>{t('pluginDevModeBadge')}</Badge> : null}
            {/* 颜色是信号：只有加载失败 / 熔断停用着 destructive，其余中性。 */}
            {loadFailed ? <Badge tone="destructive">{t('pluginLoadStatusFailed')}</Badge> : <Badge>{t('pluginLoadStatusLoaded')}</Badge>}
            {plugin.disabledReason === 'Manual' ? <Badge>{t('pluginDisabledManual')}</Badge> : null}
            {plugin.disabledReason === 'CircuitBreaker' ? <Badge tone="destructive">{t('pluginDisabledCircuitBreaker')}</Badge> : null}
            {plugin.disabledReason === 'Revoked' ? <Badge tone="destructive">{t('pluginDisabledRevoked')}</Badge> : null}
          </div>
          {plugin.homepage ? <ExtLink href={plugin.homepage} /> : null}
          {plugin.description ? <div className="line-clamp-2 break-words text-xs text-muted-foreground">{plugin.description}</div> : null}
          {loadFailed && plugin.loadError ? <div className="break-words text-xs text-destructive">{plugin.loadError}</div> : null}
        </>
      }
      actions={
        <>
          {plugin.devMode ? <IconButton icon={RotateCw} label={t('pluginReloadTooltip')} onClick={onReload} disabled={disabled} /> : null}
          <IconButton icon={Info} label={t('pluginDetailDescription')} onClick={onDetail} />
          {!loadFailed && plugin.settings.length > 0 ? (
            <IconButton icon={Settings} label={t('pluginSettingsTooltip')} onClick={onSettings} disabled={disabled} />
          ) : null}
          {!loadFailed && plugin.authSupported ? (
            <Button variant="outline" onClick={onAuth} disabled={disabled}>
              {t('pluginAuthButton')}
            </Button>
          ) : null}
          <IconButton icon={Trash2} label={t('pluginUninstallTooltip')} onClick={onUninstall} disabled={disabled} destructive />
          <Switch
            checked={plugin.enabled && !loadFailed}
            disabled={disabled || loadFailed}
            aria-label={plugin.name}
            onCheckedChange={onToggle}
            className="mx-1"
          />
        </>
      }
    />
  )
}
