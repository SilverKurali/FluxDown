//! 跨窗口共享的账户状态：一个会话消费者，设置窗口的账户页、「添加设备」对话框、
//! 入站配对确认框都读同一份数据；需要窗口的一次性提示（会话被结束、入站配对请求）
//! 以事件抛给 app，由 app 选窗口展示。

use std::sync::Arc;

use fluxdown_protocol::{
    AgentEvent, AgentSnapshot, ErrorReason, LinkPairingRequestDto, ServiceEvent,
};
use fluxdown_ui_i18n::Translator;
use gpui::{Context, Entity, EventEmitter, SharedString};

use crate::controller::AccountController;
use crate::verification::SentCodes;
use crate::{AccountCommand, AccountPort, PortFuture};

/// 需要 app 在某个窗口里展示的一次性提示。
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AccountHostEvent {
    /// 收到新的入站配对请求（`session_id`）：应弹出确认框。
    PairingRequested(String),
    /// 会话被非用户主动结束（agent 的 `SessionRevoked`）：应给出一次性提示；
    /// 提示尚未展示前原因保留在 [`AccountHost::take_pending_revocation`]。
    SessionRevoked(ErrorReason),
    /// 收到连接后的全量快照（账户页据此清除旧错误）。
    SnapshotReplaced,
    /// 用户在账户页切换了「推介有奖」入口开关：由 app 写设备本地偏好 `ui.show_settings_referral`。
    ShowReferralRequested(bool),
}

pub struct AccountHost {
    translator: Entity<Translator>,
    pub(crate) controller: AccountController,
    /// 已收到、尚未有窗口展示的撤销原因（两个承载窗口都没开时保留，下次打开主窗口补弹一次）。
    pending_revocation: Option<ErrorReason>,
    /// 已发出的验证码（跨对话框实例），重开对话框时恢复倒计时而不是重复发码。
    pub(crate) sent_codes: SentCodes,
    /// 设置侧栏是否显示「推介有奖」页的设备本地偏好（由 app 从偏好投影，缺省 `false`）。
    show_referral: bool,
}

impl EventEmitter<AccountHostEvent> for AccountHost {}

impl AccountHost {
    pub fn new(
        translator: Entity<Translator>,
        port: Arc<dyn AccountPort>,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&translator, |_, _, cx| cx.notify()).detach();
        Self {
            translator,
            controller: AccountController::new(port),
            pending_revocation: None,
            sent_codes: SentCodes::default(),
            show_referral: false,
        }
    }

    /// 设备本地偏好 `ui.show_settings_referral` 的当前值。
    #[must_use]
    pub fn show_referral(&self) -> bool {
        self.show_referral
    }

    /// 偏好变化后的投影（app 在偏好快照 / 事件上调用）；值未变时不通知。
    pub fn sync_show_referral(&mut self, value: bool, cx: &mut Context<Self>) {
        if self.show_referral != value {
            self.show_referral = value;
            cx.notify();
        }
    }

    /// 「推介有奖」页当前是否应出现在设置侧栏：已登录且偏好开启。
    #[must_use]
    pub fn referral_page_visible(&self) -> bool {
        self.show_referral && self.controller.session().is_some()
    }

    /// 账户页开关：请求 app 写偏好；偏好回流后由 [`Self::sync_show_referral`] 更新显示。
    pub(crate) fn request_show_referral(&self, value: bool, cx: &mut Context<Self>) {
        cx.emit(AccountHostEvent::ShowReferralRequested(value));
    }

    pub fn replace_snapshot(&mut self, snapshot: &AgentSnapshot, cx: &mut Context<Self>) {
        let transition = self.controller.replace_snapshot(snapshot);
        cx.emit(AccountHostEvent::SnapshotReplaced);
        self.emit_transition(transition, cx);
        cx.notify();
    }

    pub fn apply_event(&mut self, event: &ServiceEvent, cx: &mut Context<Self>) {
        // 重新登录后，此前未展示的撤销提示作废。
        if matches!(
            event,
            ServiceEvent::Agent(AgentEvent::SessionChanged(session)) if session.is_some()
        ) {
            self.pending_revocation = None;
        }
        let transition = self.controller.apply_event(event);
        let changed = transition.changed;
        self.emit_transition(transition, cx);
        if changed {
            cx.notify();
        }
    }

    pub fn mark_stale(&mut self, cx: &mut Context<Self>) {
        self.controller.mark_stale();
        cx.notify();
    }

    fn emit_transition(
        &mut self,
        transition: crate::controller::Transition,
        cx: &mut Context<Self>,
    ) {
        for id in transition.new_pairing_requests {
            cx.emit(AccountHostEvent::PairingRequested(id));
        }
        if let Some(reason) = transition.session_revoked {
            self.pending_revocation = Some(reason);
            cx.emit(AccountHostEvent::SessionRevoked(reason));
        }
    }

    #[must_use]
    pub(crate) fn translator(&self) -> &Entity<Translator> {
        &self.translator
    }

    #[must_use]
    pub(crate) fn port(&self) -> Arc<dyn AccountPort> {
        self.controller.port()
    }

    /// 仍在等待确认的入站请求（已被对端取消 / 过期后为 `None`）。
    #[must_use]
    pub fn pairing_request(&self, session_id: &str) -> Option<LinkPairingRequestDto> {
        self.controller
            .pairing_requests()
            .iter()
            .find(|request| request.session_id == session_id)
            .cloned()
    }

    /// 当前全部待确认的入站请求 ID（app 在窗口就绪后补弹启动前已存在的请求）。
    #[must_use]
    pub fn pending_pairing_requests(&self) -> Vec<String> {
        self.controller
            .pairing_requests()
            .iter()
            .map(|request| request.session_id.clone())
            .collect()
    }

    /// 取走尚未展示的撤销原因（展示时调用；无窗口可展示时不调用，原因留待补弹）。
    pub fn take_pending_revocation(&mut self) -> Option<ErrorReason> {
        self.pending_revocation.take()
    }

    /// 尚未展示的撤销原因（只读）。
    #[must_use]
    pub fn pending_revocation(&self) -> Option<ErrorReason> {
        self.pending_revocation
    }

    /// 一次性「登录已结束」提示文案。
    #[must_use]
    pub fn session_revoked_message(&self, reason: ErrorReason, cx: &gpui::App) -> SharedString {
        crate::t(
            self.translator.read(cx),
            crate::errors::session_revoked_key(reason),
        )
    }

    /// 删除云设备（删除本机设备时 agent 随后清会话，不发撤销提示）。
    pub(crate) fn delete_device(&mut self, device_id: &str) -> PortFuture<serde_json::Value> {
        self.controller.port().execute(AccountCommand::Device {
            method: fluxdown_protocol::method::AGENT_DEVICE_DELETE,
            params: serde_json::json!({ "id": device_id }),
        })
    }

    /// 让同账号另一台在线设备下线以释放在线名额（不删除设备；不能对本机调用）。
    pub(crate) fn disconnect_device(&mut self, device_id: &str) -> PortFuture<serde_json::Value> {
        self.controller.port().execute(AccountCommand::Device {
            method: fluxdown_protocol::method::AGENT_DEVICE_DISCONNECT,
            params: serde_json::json!({ "id": device_id }),
        })
    }
}
