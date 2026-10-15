// 插件与托管组件 DTO。

export interface SettingOptionDto {
  value: string;
  label: string;
}

/** 声明式设置项。 */
export interface SettingFieldDto {
  key: string;
  title: string;
  description: string;
  /** `string` / `number` / `boolean`（wire 字段名为 `type`）。 */
  type: string;
  /** `text` / `password` / `textarea` / `select` / `toggle` / `number` / `folder`。 */
  widget: string;
  options: SettingOptionDto[];
  default: string | null;
  required: boolean;
  min: number | null;
  max: number | null;
  pattern: string | null;
  /** 非空时 UI 在字段旁渲染复制按钮（仅复制文本，绝不执行）。 */
  helperScript: string | null;
  helperLabel: string | null;
}

/** 已安装插件视图。 */
export interface PluginDto {
  identity: string;
  name: string;
  version: string;
  description: string;
  homepage: string;
  enabled: boolean;
  devMode: boolean;
  /** `None` / `Manual` / `CircuitBreaker` / `Revoked`。 */
  disabledReason: string;
  settings: SettingFieldDto[];
  /** 当前设置值（key → 字符串）。 */
  settingsValues: Record<string, string>;
  /** manifest 声明的能力权限（如 `["ffmpeg"]`）。 */
  permissions: string[];
  /** 是否声明平台登录入口。 */
  authSupported: boolean;
  subscriptionProviderIds: string[];
  /** manifest resolvers[0].match.urls（glob，供扩展判断页面是否可由插件解析）。 */
  resolverUrls: string[];
  /** `Loaded` / `Failed`；与 `enabled` 独立。 */
  loadStatus: string;
  /** 加载失败原因；成功为空。 */
  loadError: string;
}

/** 插件平台登录请求。 */
export interface PluginAuthRequest {
  identity?: string;
  /** `begin` / `poll` / `cancel` / `logout` / `status`。 */
  action: string;
  site?: string;
  authRef?: string;
  sessionId?: string;
  /** 账号、验证码等额外输入。 */
  input?: string;
}

export interface PluginAuthResponse {
  /** `pending` / `success` / `error`。 */
  status: string;
  sessionId: string;
  /** 二维码文本、data URL 或其他挑战内容。 */
  challenge: string | null;
  challengeType: string | null;
  message: string;
  authRef: string | null;
}

/** 安装成功结果；`missingComponents` 是所需但未安装的基础组件（提醒式，不阻断）。 */
export interface InstalledPlugin {
  identity: string;
  missingComponents: string[];
}

/** 市场索引条目。 */
export interface MarketEntryDto {
  pluginId: string;
  version: string;
  sequence: number;
  contentHash: string;
  minAppVersion: string;
  name: string;
  description: string;
  author: string;
  homepage: string;
  mirrors: string[];
  publishTime: string;
  /** 非空 = 已被发布者撤回。 */
  yanked: string;
  tags: string[];
  permissions: string[];
}

/** daemon 托管组件标识。 */
export type ComponentKind = 'ffmpeg' | 'ytdlp';

/** ffmpeg / yt-dlp 组件状态（两者字段相同）。 */
export interface ComponentStatus {
  /** 生效路径来源：`manual` / `managed` / `system` / `none`。 */
  source: string;
  /** 生效的可执行文件路径（`none` 时为空）。 */
  path: string;
  /** 探测到的版本串（失败/未找到为空）。 */
  version: string;
  /** 托管安装记录的版本（空 = 未托管安装）。 */
  managedVersion: string;
  /** 系统 PATH 中探测到的路径（空 = 无）。 */
  systemPath: string;
  /** 当前平台是否提供托管安装。 */
  managedSupported: boolean;
}
export type ComponentFfmpegStatus = ComponentStatus;
export type ComponentYtdlpStatus = ComponentStatus;

/** 受管组件类型化状态（`{component, status}` 相邻标记）。 */
export type ComponentStatusDto =
  | { component: 'ffmpeg'; status: ComponentFfmpegStatus }
  | { component: 'ytdlp'; status: ComponentYtdlpStatus };

/** 组件可安装版本。 */
export interface ComponentVersions {
  /** 降序排列的稳定版本号。 */
  versions: string[];
  /** 最新稳定版（空 = 解析失败）。 */
  latestStable: string;
}
