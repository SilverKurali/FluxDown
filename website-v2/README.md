# FluxDown 官网 v2

面向 GPUI 桌面客户端的新版官网。Astro 5（SSR，`@astrojs/node` standalone，自托管）+ React 19 islands + Tailwind CSS v4。

## 运行

```bash
bun install
bun run dev        # http://localhost:4321
bun run build      # astro check + astro build → dist/
node dist/server/entry.mjs
```

环境变量见 `.env.example`（`GITHUB_TOKEN` 等仅 `/api/*` 路由在运行期使用）。

## 下载策略

- 官网下载页与更新日志使用 `/api/download/<filename>?source=auto&tag=<release>`：先由 GitHub 发布元数据验证非草稿 release 与精确资产，再 302 到 `OSS_CDN_BASE`。配置 CDN 时不先 HEAD OSS，也不要求官网持有 OSS 凭据，因此源站暂时不可用不会阻断已缓存的文件。
- `cdn/oss-proxy.js` 的 Cloudflare 子请求使用稳定签名 URL：命中边缘缓存直接返回，未命中回源私有 OSS；成功资源缓存 30 天，Range 交给 CF 缓存层处理。OSS 网络/响应头超时、HTTP 失败在发送下载响应前 302 到精确 GitHub tag asset，跳转 `no-store`，不缓存故障。416 保留为范围错误，不伪装成源站故障；已开始传输后的断流不能再改为跳转。
- 阿里云 OSS 默认域名禁止分发 `.apk` / `.ipa`：桶内存为 `<name>.bin`（Content-Type 须为 octet-stream），Worker 回源后覆盖 Content-Type 与 Content-Disposition 为原名；规则见 `src/lib/oss-storage.ts`，上传侧在 `.github/actions/oss-upload`。未配 CDN 时这类对象不走 OSS 直链，回退 GitHub。
- CDN 自动入口携带 `fallback=github&tag=…`；Worker 校验 tag 与 `<prefix>/<version>/<component>/<asset>` 一致，仓库仅来自 `cdn/wrangler.toml` 的 `GITHUB_REPO`（须与官网一致），不接受任意回退 URL。统一 `v…` release 的全部资产仍在 `app/`；历史 `extension-v…`、`server-v…`、`cli-v…`、`mobile-v…` 使用组件目录，显式 tag 也能区分 `app-v…` 与 `v…`。签名只存在于 CF→OSS 子请求，不下发给 CDN 客户端。
- 未配置 CDN 时，auto 沿用 OSS HEAD 校验大小后 302 到短时预签名直链、失败回退 GitHub的历史策略；这条非 CDN 兼容路径仍会向客户端提供 OSS 签名。显式 `source=github` 只用 GitHub；`source=oss` 只用已验证 OSS，不可用为 503、不启用 Worker GitHub 回退。缺省/未知 source 保留旧客户端契约。GitHub 仅有过期缓存时只允许 GitHub 直链，不授权 CDN/OSS。
- Worker 部署与官网部署需配套更新；本地回归：`bun test tests/download-backend.test.ts tests/download-route.test.ts tests/download-source.test.ts`，完整静态与构建检查：`bun run build`。这些测试调用真实路由/Worker 消费者并替换外部 fetch，不代表真实 CF 缓存命中或线上回源演练。

## 结构

| 位置 | 内容 |
|---|---|
| `src/styles/global.css` | 设计系统：OKLCH token（`html[data-theme]` 明暗）、导轨框架 `.frame/.rule/.section`、`.eyebrow/.btn/.kbd/.fig/.cells/.prose` 等组件类、视图过渡与滚动揭示 |
| `src/layouts/Layout.astro` | SEO 头、hreflang、主题预绘制、Header / Footer / ⌘K 命令面板 / 公告条 |
| `src/scripts/motion.ts` | `data-reveal` / `data-scramble` / `data-count`、`.rule` 扫描揭示、`.spot` / `.spot-edge` 聚光与边缘光、`data-magnetic` 按钮磁吸、主题圆形揭示切换、`D` 与 `⌘K` 快捷键 |
| `src/scripts/particle-stage.ts` | 粒子舞台：canvas 尺寸 / DPR、离屏停帧、`prefers-reduced-motion` 静帧、设计 token 取色（随主题切换）、宿主指针与按下事件、`StrokeBatch` 合批绘制；场景只实现 `Scene` |
| `src/i18n/` | 语言契约与路由（`config.ts`、`routing.ts`）、`defineMessages` 类型化文案、`messages/<命名空间>.ts` |
| `src/pages/[...lang]/` | 全部页面：一个文件同时产出 `/x/`（en）与 `/zh/x/`（zh） |
| `src/pages/docs/` | 文档（`/docs/<lang>/…`，内容在 `src/content/docs/{en,zh}`） |
| `src/pages/api/` | 后端接口（release / download / plugins / pay …，桌面客户端依赖其中部分，契约不随 UI 变动） |
| `src/components/home/` | 首页分区；`AppReplica.astro` + `app-demo.ts` 是 GPUI 客户端的 DOM 复刻与脚本化演示，`segment-sim.ts` 是动态分段模拟；`flux-field.ts`（首屏数据流粒子，几何与线稿共用 `hero-geometry.ts`）与 `neural-sphere.ts`（收尾 CTA 神经点云球）是两个粒子场景 |

## 语言

只维护 en + zh。en 在根路径，zh 在 `/zh` 前缀，服务端按 URL 直出，不做客户端语言探测。新增文案：在 `src/i18n/messages/` 用 `defineMessages({ en, zh })` 声明，zh 与 en 结构不一致会在 `astro check` 报错。站内链接一律经 `href(path, lang)` 生成。

## 产品短片

`/film/`（noindex）是 1920×1080 的短片舞台：片头、GPUI 复刻界面演示、镜头推拉、字幕与片尾都由同一个时钟逐帧计算，可精确复现。`public/film/` 中的视频由它生成：

1. `bun run build && node dist/server/entry.mjs`
2. 用无头 Chromium 以 1920×1080 视口打开 `/film/?hold=1`（zh 用 `/zh/film/?hold=1`），对 `i = 0 … duration×60` 依次执行 `window.__film.seek(i / 60)` 并截图为 `%05d.jpg`
3. 合成：
   ```bash
   ffmpeg -framerate 60 -i %05d.jpg -c:v libx264 -preset slow -crf 24 -pix_fmt yuv420p -movflags +faststart -tune animation fluxdown-film-<lang>.mp4
   ```
4. 海报取第 975 帧（缩放到 1600 宽）存为 `fluxdown-film-<lang>.jpg`；`public/og.png` 是 1200×630 视口下 `/film/?t=19.8` 的截图。
