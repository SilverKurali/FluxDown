/**
 * 台灣繁體中文翻譯
 */
import type { MessageKey } from "./zh-CN";

const zhTW = {
  // Header
  "header.themeToggle": "切換主題",
  "header.languageSwitch": "切換至 {language}",
  "header.checking": "偵測中...",
  "header.connected": "已連線",
  "header.disconnected": "未連線",

  // Main switch
  "switch.label": "下載攔截",
  "switch.enabled": "已開啟",
  "switch.disabled": "已關閉",

  // Stats
  "stats.title": "今日統計",
  "stats.sent": "已下載",
  "stats.failed": "失敗",
  "stats.reset": "重置統計",
  "stats.resetDone": "統計已重置",

  // Quick settings
  "settings.title": "快速設定",
  "settings.interceptMode": "攔截模式",
  "settings.modeSmart": "智慧模式",
  "settings.modeAll": "攔截所有",
  "settings.hintSmart": "綜合檔名、類型及大小進行智慧判斷",
  "settings.hintAll": "攔截所有下載（除排除網域外）",
  "settings.localDownloadHint":
    "網頁在本機產生的 blob:/data: 檔案無法接管，將由瀏覽器下載",
  "settings.minFileSize": "最小檔案大小",
  "settings.sizeNoLimit": "不限",
  "settings.interceptMagnet": "接管磁力連結",
  "settings.interceptMagnetHint": "關閉後交由系統預設磁力連結處理程式開啟（如 qBittorrent）",
  "settings.altClickHint": "Alt+Shift+D 切換攔截",
  "settings.dotVisible": "浮動球",

  // Remote download source
  "remote.title": "遠端下載來源",
  "remote.mode": "模式",
  "remote.modeOff": "僅桌面",
  "remote.modeFallback": "桌面優先",
  "remote.modeAlways": "僅遠端",
  "remote.modeHintOff": "僅透過 Native Messaging 傳送到桌面應用程式",
  "remote.modeHintFallback": "優先使用桌面應用程式，無法連線時傳送到遠端伺服器",
  "remote.modeHintAlways": "一律傳送到遠端伺服器，不再嘗試連線至桌面應用程式",
  "remote.serverUrl": "伺服器位址",
  "remote.serverUrlPlaceholder": "例如 http://192.168.1.10:17800",
  "remote.token": "存取權杖",
  "remote.tokenPlaceholder": "輸入存取權杖",
  "remote.testConnection": "測試連線",
  "remote.testing": "測試中...",
  "remote.testSuccess": "已連線（{app} v{version}）",
  "remote.testAuthFailed": "驗證失敗，請檢查存取權杖",
  "remote.testUnreachable": "無法連線至伺服器，請檢查位址與網路",
  "remote.testNotConfigured": "請先填寫伺服器位址",
  "remote.testFailed": "連線測試失敗：{message}",
  "remote.verifyRequired": "請先在設定頁通過連線測試，才能選擇遠端模式",
  "remote.openOptions": "設定伺服器",

  // Options page
  "options.title": "FluxDown 設定",
  "options.remoteDesc":
    "設定 fluxdown_server 的位址與存取權杖，通過連線測試後即可在彈出視窗中選擇遠端模式",
  "options.verifiedState": "狀態：已通過連線驗證",
  "options.unverifiedState": "狀態：未驗證（遠端模式不可用）",
  "options.navSettings": "設定",
  "options.nav.general": "一般",
  "options.nav.remote": "遠端伺服器",
  "options.general.languageTitle": "介面語言",
  "options.general.languageDesc": "選擇擴充功能介面的語言，不受瀏覽器語言影響",
  "options.general.languageAuto": "自動（跟隨瀏覽器）",
  "options.general.themeTitle": "外觀",
  "options.general.themeDesc": "擴充功能介面的主題",
  "options.theme.system": "跟隨系統",
  "options.theme.light": "淺色",
  "options.theme.dark": "深色",
  "options.tokenDesc": "伺服器首次啟動時產生的管理權杖",
  "footer.settings": "全部設定",

  "diagnostics.title": "連線診斷",
  "diagnostics.description": "匯出最近 7 天、最多 200 筆連線事件及擴充功能資訊，不包含 Cookie、權杖或下載連結。記錄僅儲存於本機，不會自動上傳。",
  "diagnostics.export": "匯出記錄",
  "diagnostics.exporting": "正在匯出…",
  "diagnostics.exportStarted": "診斷記錄已開始下載",
  "diagnostics.exportFailed": "匯出診斷記錄失敗，請在「全部設定」中再試一次。",

  // 任务发送通知开关
  "options.general.notifyLocalTitle": "本機任務通知",
  "options.general.notifyLocalDesc":
    "任務傳送到本機桌面應用程式時顯示桌面通知（建立成功/失敗）",
  "options.general.notifyRemoteTitle": "遠端任務通知",
  "options.general.notifyRemoteDesc":
    "任務傳送到遠端伺服器時顯示桌面通知（建立成功/失敗）",

  // 拦截规则配置
  "options.nav.rules": "攔截規則",
  "options.rules.extTitle": "副檔名",
  "options.rules.extDesc":
    "符合這些副檔名的下載會被攔截（智慧模式下視為符合條件）。可在下方新增自訂副檔名；內建項目無法刪除",
  "options.rules.extPlaceholder": "例如 .epub",
  "options.rules.add": "新增",
  "options.rules.builtinExts": "內建副檔名清單",
  "options.rules.extEmpty": "尚無自訂副檔名",
  "options.rules.extInvalid": "格式無效，例如：.epub",
  "options.rules.extExists": "{ext} 已在清單中",
  "options.rules.extAdded": "已新增 {ext}",
  "options.rules.mimeTitle": "MIME 類型",
  "options.rules.mimeDesc":
    "智慧模式下，符合這些 MIME 類型的回應會被攔截。以斜線結尾表示符合整個類別（例如 video/）",
  "options.rules.mimePlaceholder": "例如 application/epub+zip 或 video/",
  "options.rules.mimeInvalid": "格式無效，例如：application/epub+zip 或 video/",
  "options.rules.resetMime": "恢復預設",
  "options.rules.mimeResetDone": "已恢復預設 MIME 清單",
  "options.rules.excludeExtTitle": "排除副檔名",
  "options.rules.excludeExtDesc":
    "符合這些副檔名的下載一律不攔截，即使同時符合上方的包含規則（例如 .torrent、.crx）",
  "options.rules.excludeExtPlaceholder": "例如 .torrent",
  "options.rules.minFileSizeCustom": "自訂",
  "options.rules.minFileSizeCustomPlaceholder": "自訂大小（MB）",


  // Domain exclusion
  "domain.title": "排除網域",
  "domain.addTitle": "手動新增網域",
  "domain.add": "新增",
  "domain.cancel": "取消",
  "domain.placeholder": "輸入網域，例如 example.com",
  "domain.currentSite": "目前網站",
  "domain.empty": "尚無排除網域",
  "domain.removed": "已移除 {domain}",
  "domain.exists": "{domain} 已在排除清單中",
  "domain.excluded": "已排除 {domain}",
  "domain.invalid": "無效的網域：{domain}",
  "domain.cannotGetDomain": "無法取得目前頁面的網域",
  "domain.excludeCurrent": "排除目前網站",

  // Notifications
  "notify.batchNoLinks": "找不到連結",
  "notify.batchNoLinksDetail": "目前頁面未發現任何連結",
  "notify.batchNoDownloadableLinks": "目前頁面未發現可下載的檔案連結",
  "notify.batchComplete": "批次下載完成",
  "notify.batchResult": "共 {total} 個檔案，成功 {sent} 個，失敗 {failed} 個",
  "notify.batchExtractFailed": "擷取頁面連結失敗，請檢查頁面權限",
  "notify.downloadSent": "下載已傳送",
  "notify.sentToFluxDown": "{name} 已傳送到 FluxDown",
  "notify.batchSentDetail": "{count} 個任務已傳送到 FluxDown",
  "notify.sendFailed": "傳送失敗",
  "notify.connectionFailed": "無法連線至 FluxDown 應用程式：{message}",
  "notify.fallbackBrowser": "已改用瀏覽器下載",
  "notify.fallbackBrowserDetail":
    "無法傳送到 FluxDown，已交由瀏覽器繼續下載：{url}",
  "notify.videoSourceUnavailableTitle": "無法下載此影片/音訊",
  "notify.videoSourceUnavailableDetail":
    "此來源無法直接下載（可能是 blob:/MSE 串流），請改用資源嗅探面板",
  "notify.selectionInvalidTitle": "未辨識到可下載連結",
  "notify.selectionInvalidDetail":
    "選取的內容不是完整的 magnet:/ed2k:/http(s) 連結",
  "notify.appUnavailable": "未偵測到 FluxDown 應用程式",
  "notify.appUnavailableDetail":
    "已暫時改用瀏覽器內建下載。請確認 FluxDown 桌面應用程式已啟動，稍後將自動恢復接管。",

  // Resource sniffer & panel
  "sniffer.title": "資源嗅探",
  "sniffer.resourceSniffing": "資源嗅探",
  "sniffer.resourceSniffingHint": "偵測網頁中的可下載資源，關閉即隱藏頁面內的下載按鈕（重新開啟後需重新整理頁面）",
  "sniffer.showFloatingButton": "影片浮動按鈕",
  "sniffer.showFloatingButtonHint": "在影片元素上顯示快速下載按鈕",
  "sniffer.showResourcePanel": "資源面板",
  "sniffer.showResourcePanelHint": "在頁面底部顯示偵測到的資源清單",
  "sniffer.sniffImages": "圖片嗅探",
  "sniffer.sniffImagesHint": "偵測網頁中的大型圖片資源（>100KB）",

  // Resource panel (content script)
  "panel.selectAll": "全選",
  "panel.batchDownload": "批次下載",
  "panel.resources": "個資源",
  "panel.empty": "尚未偵測到可下載資源",
  "panel.collapse": "收起",
  "panel.more": "其他 {count} 項",
  "panel.hideDot": "隱藏浮動球",
  "panel.download": "下載",
  "panel.floatDL": "下載",
  "panel.tabAll": "全部",
  "panel.tabVideo": "影片",
  "panel.tabAudio": "音訊",
  "panel.tabDocs": "文件",
  "panel.tabArchive": "壓縮檔",
  "panel.tabStream": "串流媒體",
  "panel.tabSubtitle": "字幕",
  "panel.tabMagnet": "磁力",
  "panel.tabOther": "其他",
  "panel.qualityPickerTitle": "選擇畫質",
  "panel.trackVideo": "影片軌",
  "panel.trackAudio": "音訊軌",
  "panel.qualityUnknown": "未知畫質",
  "panel.videoCandidate": "候選影片",
  "panel.videoIndex": "影片",
  "panel.videoNeedsManifest": "已發現片段，但找不到播放清單，目前無法下載原始片段",
  "panel.autoQuality": "自動",
  "panel.originalQuality": "原始",
  "panel.downloadCandidate": "下載影片",
  "panel.previewTitle": "預覽",
  "panel.previewClose": "關閉預覽",
  "panel.previewFailed": "預覽載入失敗，可能需要登入或存在跨域限制",
  "panel.previewUnsupported": "此類型目前不支援預覽",
  "panel.previewFragmentUnsupported": "此片段無法單獨預覽，需合併後檢視",
  "panel.previewHlsUnsupported": "目前的瀏覽器無法直接預覽 HLS，請在播放頁檢視，或下載後以播放器開啟",
  "panel.previewDashUnsupported": "目前的瀏覽器無法直接預覽此 DASH 串流，請在播放頁檢視，或下載後以播放器開啟",
  "panel.previewLimited": "預覽受限",
  "panel.previewLimitedHint": "瀏覽器因跨域或登入限制而無法預覽，但仍可能成功下載（引擎會附帶登入狀態）",
  "panel.clearFailed": "清除預覽失敗項目",
  "panel.clearFailedHint": "將預覽失敗的資源從清單中隱藏（不影響其他資源，也不代表無法下載）",
  "panel.exportDebugLog": "匯出除錯記錄",
  "panel.exportDebugLogFailed": "匯出嗅探除錯記錄失敗",
  "panel.clearResources": "清除",
  "panel.clearResourcesTitle": "清除目前頁面的嗅探資源清單",
  "panel.exportDebugLogTitle": "匯出目前頁面的原始嗅探資源、播放清單與彙整關係",
  "panel.exportDebugLogDone": "嗅探除錯記錄已匯出",

  // Shortcut toggle
  "shortcut.toggleTitle": "攔截切換",
  "shortcut.interceptOn": "下載攔截已開啟",
  "shortcut.interceptOff": "下載攔截已關閉",

  // Context menu
  "contextMenu.sendToFluxDown": "使用 FluxDown 下載此連結",
  "contextMenu.sendVideoToFluxDown": "使用 FluxDown 下載此影片/音訊",
  "contextMenu.sendSelectionToFluxDown": "使用 FluxDown 下載選取的內容",
  "contextMenu.sendImageToFluxDown": "使用 FluxDown 下載此圖片",
  "contextMenu.sendPageToFluxDown": "使用 FluxDown 下載此頁面",

  // Manifest
  "manifest.description":
    "攔截瀏覽器下載，傳送到 FluxDown 桌面應用程式以進行高速下載",

  // 顶部 tab（popup）
  "popup.tabs.tasks": "任務",
  "popup.tabs.resources": "資源",
  "popup.tabs.settings": "設定",

  // 资源面板（popup）
  "popup.resources.empty": "目前頁面尚未嗅探到資源",

  // 任务面板（popup）
  "popup.tasks.downloading": "下載中",
  "popup.tasks.completed": "最近完成",
  "popup.tasks.empty": "尚無下載任務",
  "popup.tasks.appNotRunning": "FluxDown 未執行",
  "popup.tasks.startApp": "啟動 FluxDown",
  "popup.tasks.starting": "啟動中…",
  "popup.tasks.statsToday": "今日：",
  "popup.tasks.statsLineTitle": "開啟設定檢視更多",
  "popup.task.pause": "暫停",
  "popup.task.resume": "繼續",
  "popup.task.remove": "刪除",
  "popup.task.open": "開啟",
  "popup.task.reveal": "資料夾",
  "popup.task.paused": "已暫停",
  "popup.task.pending": "等待中",
  "popup.task.preparing": "準備中",
  "popup.task.errorGeneric": "下載發生錯誤",
  "popup.task.opFailed": "操作失敗",

  // 空态快捷下载（popup）
  "popup.quickDownload.placeholder": "貼上下載連結",
  "popup.quickDownload.button": "下載",
  "popup.quickDownload.invalidUrl": "請輸入有效的下載連結",
  "popup.quickDownload.sent": "已傳送到 FluxDown",
  "popup.quickDownload.failed": "傳送失敗",

  // Options 迁移项补充说明
  "options.general.statsDesc": "重置彈出視窗中顯示的已下載/失敗計數",
  "options.rules.minFileSizeDesc": "小於此大小的檔案不會被攔截",
  "options.rules.domainDesc": "來自這些網域（含子網域）的下載，以及從這些網域頁面開始的下載，都不會被攔截",

  // 自定义协议（fluxdown://）
  "options.protocol.label": "FluxDown 自訂通訊協定",
  "options.protocol.enabled": "已啟用，透過 fluxdown:// 啟動應用程式",
  "options.protocol.disabled": "關閉（預設）",
  "options.protocol.desc": "透過 fluxdown:// 通訊協定啟動應用程式進行下載，Windows / macOS / Linux / Android 均支援。本機通道的功能較完整，建議僅在無法使用本機通道時開啟",

  // 任务完成通知（任务面板）
  "notify.taskCompletedTitle": "下載完成",
  "notify.taskCompletedDetail": "{name} 已下載完成",
  "notify.openFile": "開啟檔案",
  "notify.openFolder": "開啟資料夾",
} as const satisfies Record<MessageKey, string>;

export default zhTW;
