//! 账户状态的全局宿主：一个 [`AccountHost`] 订阅 agent 会话，供设置窗口的账户页、
//! 「添加设备」对话框共享；这里把它的一次性提示落到窗口上——
//! 入站局域网配对请求弹确认框，agent 的 `SessionRevoked` 给一次性通知。

use std::{collections::HashSet, sync::Arc};

use fluxdown_protocol::ErrorReason;
use fluxdown_ui_account::{AccountHost, AccountHostEvent, open_add_device, open_pairing_prompt};
use fluxdown_ui_i18n::Translator;
use fluxdown_ui_settings::SettingsStore;
use gpui::{App, AppContext as _, Entity, Global, Window};
use gpui_component::{WindowExt as _, notification::Notification};

use crate::{
    account_port::AgentAccountPort,
    agent_client::AgentClient,
    app::Desktop,
    session::{AgentSession, attach},
    windows::{WindowRegistry, bring_to_front},
};

/// 已经弹出过确认框的入站请求（`session_id`），避免重连快照重复弹窗。
#[derive(Default)]
struct PromptedRequests(HashSet<String>);

impl Global for PromptedRequests {}

/// 创建并装配账户宿主：订阅会话，登记提示落点。
pub(crate) fn install(
    translator: &Entity<Translator>,
    session: &Entity<AgentSession>,
    client: &Arc<AgentClient>,
    cx: &mut App,
) -> Entity<AccountHost> {
    let port = Arc::new(AgentAccountPort::new(client.clone()));
    let host = cx.new(|cx| AccountHost::new(translator.clone(), port, cx));
    cx.set_global(PromptedRequests::default());
    cx.subscribe(&host, |host, event, cx| match event {
        AccountHostEvent::PairingRequested(id) => show_pairing_prompt(&host, id, cx),
        AccountHostEvent::SessionRevoked(reason) => notify_session_revoked(&host, *reason, cx),
        AccountHostEvent::SnapshotReplaced => {}
        AccountHostEvent::ShowReferralRequested(value) => {
            Desktop::set_pref(cx, SHOW_REFERRAL_PREF, serde_json::Value::Bool(*value));
        }
    })
    .detach();
    attach(session, &host, cx);
    host
}

/// 设备本地偏好：设置侧栏是否显示「推介有奖」页（缺省 false）。不在云同步目录内，
/// `SettingsStore::set_pref` 对目录外的键走 `sync:false` 路径，因此永不上云。
pub(crate) const SHOW_REFERRAL_PREF: &str = "ui.show_settings_referral";

/// 偏好 → 账户宿主 → 设置页可见性：偏好变化投影到宿主（账户页开关的显示值），宿主（登录态）
/// 或偏好任一变化都重算「已登录 && 偏好开启」并推给 [`Desktop::referral_visibility`]。
/// 要求 `Desktop` 全局已就绪。
pub(crate) fn bind_referral_visibility(cx: &mut App) {
    let desktop = Desktop::global(cx);
    let store = desktop.settings_store.clone();
    let host = desktop.account_host.clone();
    let visibility = desktop.referral_visibility.clone();

    let project_pref = {
        let host = host.clone();
        move |store: &Entity<SettingsStore>, cx: &mut App| {
            let value = store
                .read(cx)
                .pref(SHOW_REFERRAL_PREF)
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            host.update(cx, |host, cx| host.sync_show_referral(value, cx));
        }
    };
    let project_visibility = {
        let visibility = visibility.clone();
        move |host: &Entity<AccountHost>, cx: &mut App| {
            let visible = host.read(cx).referral_page_visible();
            visibility.update(cx, |visibility, cx| visibility.set(visible, cx));
        }
    };

    project_pref(&store, cx);
    project_visibility(&host, cx);
    cx.observe(&store, move |store, cx| project_pref(&store, cx))
        .detach();
    cx.observe(&host, move |host, cx| project_visibility(&host, cx))
        .detach();
}

/// 主窗口就绪后补弹窗口尚不存在时被跳过的提示：入站配对请求与会话撤销通知（各一次）。
pub(crate) fn replay_pending(cx: &mut App) {
    let host = Desktop::global(cx).account_host.clone();
    for id in host.read(cx).pending_pairing_requests() {
        show_pairing_prompt(&host, &id, cx);
    }
    if let Some(reason) = host.read(cx).pending_revocation() {
        notify_session_revoked(&host, reason, cx);
    }
}

fn show_pairing_prompt(host: &Entity<AccountHost>, id: &str, cx: &mut App) {
    let pending = host.read(cx).pending_pairing_requests();
    let prompted = cx.global_mut::<PromptedRequests>();
    prompted.0.retain(|shown| pending.contains(shown));
    if prompted.0.contains(id) {
        return;
    }
    let Some(handle) = WindowRegistry::overlay_window(cx) else {
        return;
    };
    let host = host.clone();
    let id = id.to_owned();
    let shown = handle
        .update(cx, |_, window, cx| {
            bring_to_front(window, cx);
            open_pairing_prompt(&host, &id, window, cx);
        })
        .is_ok();
    if shown {
        cx.global_mut::<PromptedRequests>().0.insert(id);
    }
}

/// 会话被撤销的一次性通知；没有承载窗口时原因留在宿主里，等主窗口打开后补弹。
fn notify_session_revoked(host: &Entity<AccountHost>, reason: ErrorReason, cx: &mut App) {
    let Some(handle) = WindowRegistry::overlay_window(cx) else {
        return;
    };
    let message = host.read(cx).session_revoked_message(reason, cx);
    let shown = handle
        .update(cx, |_, window, cx| {
            window.push_notification(Notification::warning(message), cx);
        })
        .is_ok();
    if shown {
        host.update(cx, |host, _| {
            host.take_pending_revocation();
        });
    }
}

/// 侧栏「添加设备」入口：在触发它的窗口里打开对话框。
pub(crate) fn open_add_device_dialog(window: &mut Window, cx: &mut App) {
    let host = Desktop::global(cx).account_host.clone();
    open_add_device(&host, window, cx);
}
