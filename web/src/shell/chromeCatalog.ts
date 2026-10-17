// Web 外壳条目目录：id / 默认区域 / 可放置的区域族。
// 默认区域复现改造前的布局（顺序即目录顺序）；文本类条目（速度 / 剩余空间）放不进 48px 活动栏。
// id 与 GPUI 共用（GPUI 另有 `shutdown`，Web 没有）。

import type { ChromeItemSpec } from './chromeLayout'

export const CHROME_CATALOG: readonly ChromeItemSpec[] = [
  { id: 'downloads', defaultZone: 'railTop', families: ['rail', 'title', 'status'] },
  { id: 'rss', defaultZone: 'railTop', families: ['rail', 'title', 'status'] },
  { id: 'webhooks', defaultZone: 'railTop', families: ['rail', 'title', 'status'] },
  { id: 'account', defaultZone: 'railBottom', families: ['rail', 'title'] },
  { id: 'settings', defaultZone: 'railBottom', families: ['rail', 'title', 'status'] },
  { id: 'downloadSpeed', defaultZone: 'statusLeading', families: ['title', 'status'] },
  { id: 'uploadSpeed', defaultZone: 'statusLeading', families: ['title', 'status'] },
  { id: 'pauseAll', defaultZone: 'statusLeading', families: ['rail', 'title', 'status'] },
  { id: 'resumeAll', defaultZone: 'statusLeading', families: ['rail', 'title', 'status'] },
  { id: 'downloadLimit', defaultZone: 'statusTrailing', families: ['rail', 'title', 'status'] },
  { id: 'uploadLimit', defaultZone: 'statusTrailing', families: ['rail', 'title', 'status'] },
  { id: 'proxy', defaultZone: 'statusTrailing', families: ['rail', 'title', 'status'] },
  { id: 'diskFree', defaultZone: 'statusTrailing', families: ['title', 'status'] },
]

/** 小部件条目的文案键（路由 / 账户条目沿用 `ACTIVITY_ENTRIES` 的 `labelKey`）；编辑态拖动手柄的名称提示用。 */
export const WIDGET_LABEL_KEY: Readonly<Record<string, string>> = {
  downloadSpeed: 'chromeWidgetDownloadSpeed',
  uploadSpeed: 'chromeWidgetUploadSpeed',
  pauseAll: 'pauseAll',
  resumeAll: 'resumeAll',
  downloadLimit: 'speedLimitTitle',
  uploadLimit: 'uploadLimit',
  proxy: 'statusBarProxyLabel',
  diskFree: 'chromeWidgetDiskFree',
}
