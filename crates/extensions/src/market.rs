//! 插件市场目录的纯逻辑：按插件归并版本条目、判定安装 / 更新动作、权限增量与撤回标记。
//!
//! 版本选择与引擎 `MarketClient::latest_entry` 同一规则（`yanked == "none"` 中 sequence
//! 最大者），保证列表展示的版本就是 `daemon.plugin.marketInstall` 实际装上的版本。

use std::collections::HashMap;

use fluxdown_protocol::{MarketEntryDto, PluginDto};

/// 引擎只安装 `yanked == "none"` 的条目（`MarketClient::install_latest` 不放行任何撤回版本）。
fn installable(entry: &MarketEntryDto) -> bool {
    entry.yanked == "none"
}

/// 每个插件一条：优先最新可安装版本；全部撤回时取 sequence 最大者（仅用于展示撤回标记）。
/// 顺序保持各插件在索引中首次出现的位置。
pub fn latest_per_plugin(entries: &[MarketEntryDto]) -> Vec<MarketEntryDto> {
    let mut order: Vec<&str> = Vec::new();
    let mut best: HashMap<&str, &MarketEntryDto> = HashMap::new();
    for entry in entries {
        let id = entry.plugin_id.as_str();
        match best.get(id) {
            None => {
                order.push(id);
                best.insert(id, entry);
            }
            Some(current) => {
                let better = match (installable(entry), installable(current)) {
                    (true, false) => true,
                    (false, true) => false,
                    _ => entry.sequence > current.sequence,
                };
                if better {
                    best.insert(id, entry);
                }
            }
        }
    }
    order
        .into_iter()
        .filter_map(|id| best.get(id).map(|entry| (*entry).clone()))
        .collect()
}

/// 市场条目关键字过滤：名称 / id / 描述 / 作者 / 标签任一命中（大小写不敏感）。
pub fn filter_market<'a>(entries: &'a [MarketEntryDto], query: &str) -> Vec<&'a MarketEntryDto> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return entries.iter().collect();
    }
    let hit = |value: &str| value.to_lowercase().contains(&query);
    entries
        .iter()
        .filter(|entry| {
            hit(&entry.name)
                || hit(&entry.plugin_id)
                || hit(&entry.description)
                || hit(&entry.author)
                || entry.tags.iter().any(|tag| hit(tag))
        })
        .collect()
}

/// 解析 `MAJOR.MINOR.PATCH`（可带前导 `v`，忽略预发布 / 构建后缀），与引擎
/// `plugin::semver::parse_semver` 同语义；UI crate 不依赖引擎，故本地保留一份。
fn parse_semver(version: &str) -> Option<(u64, u64, u64)> {
    let version = version.trim();
    let version = version.strip_prefix('v').unwrap_or(version);
    let core = version.split(['-', '+']).next().unwrap_or(version);
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// `candidate` 严格新于 `current` 时为真；任一侧无法解析视为不可比较（不提示更新）。
pub fn version_newer(candidate: &str, current: &str) -> bool {
    match (parse_semver(candidate), parse_semver(current)) {
        (Some(candidate), Some(current)) => candidate > current,
        _ => false,
    }
}

/// 市场条目相对本机安装状态的可执行动作。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarketAction {
    Install,
    Update,
    Installed,
    /// 市场只剩撤回版本：引擎会拒绝安装。
    Unavailable,
}

/// 开发模式插件的源码由本地目录管理，不从市场覆盖。
pub fn market_action(entry: &MarketEntryDto, installed: Option<&PluginDto>) -> MarketAction {
    match installed {
        None if installable(entry) => MarketAction::Install,
        None => MarketAction::Unavailable,
        Some(plugin)
            if !plugin.dev_mode
                && installable(entry)
                && version_newer(&entry.version, &plugin.version) =>
        {
            MarketAction::Update
        }
        Some(_) => MarketAction::Installed,
    }
}

/// 需要用户确认的权限：新装取条目全部权限，更新只取已安装版本没有的新增权限。
pub fn permissions_to_confirm(
    entry: &MarketEntryDto,
    installed: Option<&PluginDto>,
) -> Vec<String> {
    let granted: &[String] = installed.map_or(&[], |plugin| &plugin.permissions);
    entry
        .permissions
        .iter()
        .filter(|permission| !granted.contains(permission))
        .cloned()
        .collect()
}

/// 用户确认权限之后市场索引又变化时，原确认是否仍覆盖将要安装的内容：
/// 版本不变，且需确认的权限没有超出用户已确认的集合。
pub fn confirmation_holds(
    confirmed_version: &str,
    confirmed_permissions: &[String],
    latest: &MarketEntryDto,
    installed: Option<&PluginDto>,
) -> bool {
    latest.version == confirmed_version
        && permissions_to_confirm(latest, installed)
            .iter()
            .all(|permission| confirmed_permissions.contains(permission))
}

/// 已安装版本在市场中的撤回标记（`deprecated` / `vulnerable` / `malicious`）；未撤回或
/// 市场无此版本返回 `None`。
pub fn installed_version_yanked<'a>(
    entries: &'a [MarketEntryDto],
    plugin: &PluginDto,
) -> Option<&'a str> {
    if plugin.dev_mode {
        return None;
    }
    entries
        .iter()
        .find(|entry| entry.plugin_id == plugin.identity && entry.version == plugin.version)
        .map(|entry| entry.yanked.as_str())
        .filter(|yanked| !yanked.is_empty() && *yanked != "none")
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use fluxdown_protocol::{MarketEntryDto, PluginDto};

    use super::{
        MarketAction, confirmation_holds, filter_market, installed_version_yanked,
        latest_per_plugin, market_action, permissions_to_confirm, version_newer,
    };

    fn entry(id: &str, version: &str, sequence: u64, yanked: &str) -> MarketEntryDto {
        MarketEntryDto {
            plugin_id: id.to_owned(),
            version: version.to_owned(),
            sequence,
            content_hash: String::new(),
            min_app_version: String::new(),
            name: String::new(),
            description: String::new(),
            author: String::new(),
            homepage: String::new(),
            mirrors: Vec::new(),
            publish_time: String::new(),
            yanked: yanked.to_owned(),
            tags: Vec::new(),
            permissions: Vec::new(),
        }
    }

    fn plugin(id: &str, version: &str, dev_mode: bool, permissions: &[&str]) -> PluginDto {
        PluginDto {
            identity: id.to_owned(),
            name: id.to_owned(),
            version: version.to_owned(),
            description: String::new(),
            homepage: String::new(),
            enabled: true,
            dev_mode,
            disabled_reason: "None".to_owned(),
            settings: Vec::new(),
            settings_values: HashMap::new(),
            permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
            auth_supported: false,
            subscription_provider_ids: Vec::new(),
            resolver_urls: Vec::new(),
            load_status: "Loaded".to_owned(),
            load_error: String::new(),
        }
    }

    #[test]
    fn catalog_keeps_one_row_per_plugin_with_the_version_the_engine_installs() {
        let entries = [
            entry("a@x", "1.0.0", 1, "none"),
            entry("b@y", "0.1.0", 2, "none"),
            entry("a@x", "1.2.0", 3, "none"),
            // 更高 sequence 但已撤回：引擎不会装它。
            entry("a@x", "1.3.0", 4, "vulnerable"),
        ];
        let catalog = latest_per_plugin(&entries);
        let rows = catalog
            .iter()
            .map(|e| (e.plugin_id.as_str(), e.version.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(rows, vec![("a@x", "1.2.0"), ("b@y", "0.1.0")]);
    }

    #[test]
    fn fully_yanked_plugin_shows_newest_entry_and_is_unavailable() {
        let entries = [
            entry("a@x", "1.0.0", 1, "deprecated"),
            entry("a@x", "1.1.0", 2, "malicious"),
        ];
        let catalog = latest_per_plugin(&entries);
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].version, "1.1.0");
        assert_eq!(market_action(&catalog[0], None), MarketAction::Unavailable);
    }

    #[test]
    fn semver_comparison_is_numeric_not_lexical() {
        assert!(version_newer("0.10.0", "0.9.9"));
        assert!(version_newer("v2.0.0", "1.99.99"));
        assert!(!version_newer("1.0.0", "1.0.0"));
        assert!(!version_newer("1.0.0-rc.1", "1.0.0"));
        assert!(!version_newer("garbage", "1.0.0"));
        assert!(!version_newer("2.0.0", ""));
    }

    #[test]
    fn action_offers_update_only_for_newer_non_dev_installs() {
        let latest = entry("a@x", "1.2.0", 3, "none");
        assert_eq!(market_action(&latest, None), MarketAction::Install);
        assert_eq!(
            market_action(&latest, Some(&plugin("a@x", "1.0.0", false, &[]))),
            MarketAction::Update
        );
        assert_eq!(
            market_action(&latest, Some(&plugin("a@x", "1.2.0", false, &[]))),
            MarketAction::Installed
        );
        // 本地比市场新（如作者本地调试版）不降级。
        assert_eq!(
            market_action(&latest, Some(&plugin("a@x", "2.0.0", false, &[]))),
            MarketAction::Installed
        );
        assert_eq!(
            market_action(&latest, Some(&plugin("a@x", "1.0.0", true, &[]))),
            MarketAction::Installed
        );
    }

    #[test]
    fn update_confirms_only_newly_requested_permissions() {
        let mut latest = entry("a@x", "1.2.0", 3, "none");
        latest.permissions = vec!["ffmpeg".to_owned(), "ytdlp".to_owned()];
        assert_eq!(
            permissions_to_confirm(&latest, None),
            vec!["ffmpeg".to_owned(), "ytdlp".to_owned()]
        );
        let installed = plugin("a@x", "1.0.0", false, &["ffmpeg"]);
        assert_eq!(
            permissions_to_confirm(&latest, Some(&installed)),
            vec!["ytdlp".to_owned()]
        );
        let full = plugin("a@x", "1.0.0", false, &["ffmpeg", "ytdlp"]);
        assert!(permissions_to_confirm(&latest, Some(&full)).is_empty());
    }

    #[test]
    fn confirmation_breaks_on_new_version_or_extra_permission() {
        let mut latest = entry("a@x", "1.2.0", 3, "none");
        latest.permissions = vec!["ffmpeg".to_owned()];
        let confirmed = vec!["ffmpeg".to_owned()];
        assert!(confirmation_holds("1.2.0", &confirmed, &latest, None));
        // 版本在确认后变了。
        assert!(!confirmation_holds("1.1.0", &confirmed, &latest, None));
        // 新版本多要了权限。
        latest.permissions.push("ytdlp".to_owned());
        assert!(!confirmation_holds("1.2.0", &confirmed, &latest, None));
        // 已安装版本已授予的权限无需再确认。
        let installed = plugin("a@x", "1.0.0", false, &["ytdlp"]);
        assert!(confirmation_holds(
            "1.2.0",
            &confirmed,
            &latest,
            Some(&installed)
        ));
    }

    #[test]
    fn installed_version_yank_is_reported_even_when_a_fix_exists() {
        let entries = [
            entry("a@x", "1.0.0", 1, "malicious"),
            entry("a@x", "1.1.0", 2, "none"),
        ];
        assert_eq!(
            installed_version_yanked(&entries, &plugin("a@x", "1.0.0", false, &[])),
            Some("malicious")
        );
        assert_eq!(
            installed_version_yanked(&entries, &plugin("a@x", "1.1.0", false, &[])),
            None
        );
        assert_eq!(
            installed_version_yanked(&entries, &plugin("a@x", "1.0.0", true, &[])),
            None
        );
    }

    #[test]
    fn empty_query_keeps_everything() {
        let entries = [
            entry("a", "1.0.0", 1, "none"),
            entry("b", "1.0.0", 2, "none"),
        ];
        assert_eq!(filter_market(&entries, "   ").len(), 2);
    }

    #[test]
    fn query_matches_any_field_case_insensitively() {
        let mut video = entry("video.dl", "1.0.0", 1, "none");
        video.name = "Video".to_owned();
        video.description = "grabs videos".to_owned();
        video.author = "Ann".to_owned();
        video.tags = vec!["media".to_owned()];
        let mut other = entry("other", "1.0.0", 2, "none");
        other.name = "Other".to_owned();
        other.description = "misc".to_owned();
        other.author = "Bob".to_owned();
        other.tags = vec!["tools".to_owned()];
        let entries = [video, other];
        let ids = |query: &str| {
            filter_market(&entries, query)
                .into_iter()
                .map(|entry| entry.plugin_id.as_str())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids("VIDEO"), vec!["video.dl"]);
        assert_eq!(ids("bob"), vec!["other"]);
        assert_eq!(ids("media"), vec!["video.dl"]);
        assert_eq!(ids("grabs"), vec!["video.dl"]);
        assert!(ids("nothing").is_empty());
    }
}
