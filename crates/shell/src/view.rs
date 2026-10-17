use std::rc::Rc;

use fluxdown_ui_components::{FluxIcon, SidebarState, toolbar_action_button};
use fluxdown_ui_i18n::Translator;
use fluxdown_ui_theme::active_theme;
use gpui::{
    AnyElement, AnyView, App, Context, Entity, FontWeight, InteractiveElement as _, IntoElement,
    MouseButton, ParentElement, Pixels, Render, SharedString, StatefulInteractiveElement as _,
    Styled, Window, div, img, percentage, px,
};
use gpui_component::{Icon, TitleBar, h_flex, tooltip::Tooltip, v_flex};

use crate::assets::APP_LOGO_PATH;
use crate::chrome::{ACTIVITY_BUTTON_SIZE, LayoutChangeHandler, ShellChrome, ShellWidget};
use crate::window_controls::FixedSizeTitleBar;
use crate::{ChromeItemSpec, ChromeLayout, ChromeZone};

/// shell 路由的稳定标识。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouteId(&'static str);

impl RouteId {
    /// 创建稳定路由标识。
    pub const fn new(value: &'static str) -> Self {
        Self(value)
    }

    /// 标识字符串，同时是 chrome 布局里的条目 id。
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        self.0
    }
}

/// 由应用装配并注入 shell 的路由元数据与页面内容。
pub struct ShellRoute {
    pub(crate) id: RouteId,
    pub(crate) button_id: &'static str,
    pub(crate) tooltip_id: &'static str,
    pub(crate) label_key: &'static str,
    pub(crate) icon: Icon,
    view: AnyView,
    /// 路由活跃时渲染在统一顶栏中的插槽（靠右内容由插槽自己排布）。
    title_bar: Option<AnyView>,
    /// 页面独立侧栏状态；由 shell 统一提供顶栏收起 / 展开入口。
    sidebar: Option<Entity<SidebarState>>,
    /// 可选路由参与活动栏「是否整体渲染」的判定；固定路由（如下载）不参与。
    pub(crate) optional: bool,
    pub(crate) visible: bool,
}

impl ShellRoute {
    /// 创建一条 shell 路由；默认固定显示（非可选、可见）。
    pub fn new(
        id: RouteId,
        button_id: &'static str,
        tooltip_id: &'static str,
        label_key: &'static str,
        icon: Icon,
        view: AnyView,
    ) -> Self {
        Self {
            id,
            button_id,
            tooltip_id,
            label_key,
            icon,
            view,
            title_bar: None,
            sidebar: None,
            optional: false,
            visible: true,
        }
    }

    /// 标记该路由是否为「可选」：活动栏在没有任何可见可选项时整体收起。
    pub fn optional(mut self, optional: bool) -> Self {
        self.optional = optional;
        self
    }

    /// 为该路由挂载统一顶栏插槽：路由活跃时 shell 在标题栏中渲染它。
    ///
    /// 插槽内可交互元素须自行拦截左键 `mouse_down` 冒泡，空白处保持窗口拖拽 / 双击。
    pub fn with_title_bar(mut self, view: impl Into<AnyView>) -> Self {
        self.title_bar = Some(view.into());
        self
    }

    /// 为有侧边菜单的路由登记共享侧栏状态；按钮位置与行为由 shell 统一管理。
    pub fn with_sidebar(mut self, sidebar: Entity<SidebarState>) -> Self {
        self.sidebar = Some(sidebar);
        self
    }
}

type ShellActionHandler = Rc<dyn Fn(&mut Window, &mut App)>;

/// 活动栏动作的呈现：标准图标按钮，或由 app 注入的自绘视图（如账户头像）。
pub(crate) enum ShellActionContent {
    Button {
        tooltip_id: &'static str,
        icon: Box<Icon>,
        handler: ShellActionHandler,
    },
    /// 自绘视图自带悬浮提示与点击行为；shell 只提供按钮位。
    View(AnyView),
}

/// 由应用装配并注入 shell 的窗口级动作（默认摆在活动栏底部，可经布局移动）。
pub struct ShellAction {
    pub(crate) button_id: &'static str,
    /// chrome 布局里的条目 id；缺省同 `button_id`。
    pub(crate) layout_id: &'static str,
    /// 悬浮提示 / 编辑模式拖拽预览的文案键。
    pub(crate) label_key: &'static str,
    pub(crate) content: ShellActionContent,
    /// 可选动作参与活动栏「是否整体渲染」的判定；固定动作（如设置）不参与。
    pub(crate) optional: bool,
    pub(crate) visible: bool,
}

impl ShellAction {
    /// 创建不切换主内容路由的动作；默认固定显示（非可选、可见）。
    pub fn new(
        button_id: &'static str,
        tooltip_id: &'static str,
        label_key: &'static str,
        icon: Icon,
        handler: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            button_id,
            layout_id: button_id,
            label_key,
            content: ShellActionContent::Button {
                tooltip_id,
                icon: Box::new(icon),
                handler: Rc::new(handler),
            },
            optional: false,
            visible: true,
        }
    }

    /// 以自绘视图占据一个按钮位（[`ShellView::ACTION_BUTTON_SIZE`] 见方，居中摆放）。
    /// 视图自行观察数据源并 notify，shell 不重建它。
    pub fn view(button_id: &'static str, label_key: &'static str, view: AnyView) -> Self {
        Self {
            button_id,
            layout_id: button_id,
            label_key,
            content: ShellActionContent::View(view),
            optional: false,
            visible: true,
        }
    }

    /// 设置 chrome 布局里的条目 id。
    pub fn layout_id(mut self, layout_id: &'static str) -> Self {
        self.layout_id = layout_id;
        self
    }

    /// 标记该动作是否为「可选」：活动栏在没有任何可见可选项时整体收起。
    pub fn optional(mut self, optional: bool) -> Self {
        self.optional = optional;
        self
    }
}

/// 使用 FluxDown 自定义标题栏承载任意能力页面的辅助窗口。
pub struct AuxiliaryWindowView {
    _translator: Entity<Translator>,
    title: SharedString,
    /// 已写入 OS 窗口标题的默认标题；与 `title` 不同说明语言切换后需要同步。
    os_title: SharedString,
    /// 宿主设置的动态标题（如任务文件名）；存在时优先于按语言刷新的默认标题。
    title_override: Option<SharedString>,
    content: AnyView,
    /// 窗口是否可由用户调整尺寸；`false` 时 Windows / Linux 自绘只含最小化 + 关闭的标题栏
    /// （系统不会响应最大化，留着只会误导）。macOS 恒用系统交通灯。
    resizable: bool,
    /// 已应用到 macOS 交通灯的纵向偏移；标题栏随文字放大撑高时重新居中。
    traffic_light_y: Pixels,
}

impl AuxiliaryWindowView {
    /// 创建跟随共享语言状态更新标题的辅助窗口 chrome。
    pub fn new(
        translator: Entity<Translator>,
        title_key: &'static str,
        content: AnyView,
        cx: &mut Context<Self>,
    ) -> Self {
        let title = SharedString::from(translator.read(cx).text(title_key).to_owned());
        cx.observe(&translator, move |this, translator, cx| {
            this.title = SharedString::from(translator.read(cx).text(title_key).to_owned());
            cx.notify();
        })
        .detach();
        Self {
            _translator: translator,
            os_title: title.clone(),
            title,
            title_override: None,
            content,
            resizable: true,
            traffic_light_y: crate::initial_traffic_light_y(),
        }
    }

    /// 声明承载窗口是否可调整尺寸（默认可调）；应与窗口选项的 `is_resizable` 保持一致。
    #[must_use]
    pub fn resizable(mut self, resizable: bool) -> Self {
        self.resizable = resizable;
        self
    }

    /// 以动态文本覆盖标题（传 `None` 恢复按语言键显示的默认标题）。
    pub fn set_title(&mut self, title: Option<SharedString>, cx: &mut Context<Self>) {
        if self.title_override != title {
            if title.is_none() {
                // 宿主自己写过 OS 标题；恢复默认时需要重新同步。
                self.os_title = SharedString::default();
            }
            self.title_override = title;
            cx.notify();
        }
    }

    /// 辅助窗口标题栏：与主窗口统一顶栏同为 chrome 底 + hairline 底线；标题 sm MEDIUM，
    /// 三平台一致左对齐（macOS 紧随交通灯，Windows/Linux 自窗口左缘起）。
    ///
    /// 标题行以绝对定位铺满拖动区、不参与内容宽度：gpui-component 的拖动区不允许收缩，
    /// 在流内的单行标题会按其不换行的最小宽度把右侧窗口控制按钮挤出窗口。
    /// 不可调尺寸的窗口在 Windows / Linux 改用 [`FixedSizeTitleBar`]（无最大化按钮）。
    fn render_title_bar(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = active_theme(cx);
        let tokens = theme.tokens();
        let extended = theme.extended().colors;
        let spacing = tokens.spacing;
        let typography = tokens.typography.clone();
        let height = crate::title_bar_height(cx);
        let title_row = h_flex()
            .absolute()
            .inset_0()
            .items_center()
            .pl(spacing.sm)
            .pr(spacing.md)
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(typography.sm.size)
                    .line_height(typography.sm.line_height)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(tokens.colors.foreground)
                    .child(
                        self.title_override
                            .clone()
                            .unwrap_or_else(|| self.title.clone()),
                    ),
            );

        // 显式 `.bg` 覆盖 gpui-component 默认渐变；`.h` 经 refine_style 覆盖默认 34px。
        if !self.resizable && !cfg!(target_os = "macos") {
            return FixedSizeTitleBar::new()
                .pl(spacing.sm)
                .h(height)
                .bg(extended.chrome)
                .border_color(extended.hairline)
                .child(title_row)
                .into_any_element();
        }
        let title_bar = TitleBar::new();
        #[cfg(not(target_os = "macos"))]
        let title_bar = title_bar.pl(spacing.sm);
        title_bar
            .h(height)
            .bg(extended.chrome)
            .border_color(extended.hairline)
            .child(title_row)
            .into_any_element()
    }
}

impl Render for AuxiliaryWindowView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        crate::sync_traffic_light(
            window,
            crate::title_bar_height(cx),
            &mut self.traffic_light_y,
        );
        // 构造时拿不到 Window：语言切换后在渲染期把默认标题同步到 OS 窗口标题。
        if self.title_override.is_none() && self.os_title != self.title {
            window.set_window_title(&self.title);
            self.os_title = self.title.clone();
        }
        let colors = active_theme(cx).tokens().colors;
        v_flex()
            .size_full()
            .relative()
            .bg(colors.surface)
            .text_color(colors.foreground)
            .child(self.render_title_bar(cx))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .min_h_0()
                    .bg(colors.surface)
                    .child(self.content.clone()),
            )
    }
}

/// GPUI 窗口外壳：窗口 chrome（顶栏 / 活动栏 / 状态栏）、路由与内容槽位；
/// chrome 条目的摆放由 [`ChromeLayout`] 决定（渲染见 `chrome.rs`）。
pub struct ShellView {
    pub(crate) translator: Entity<Translator>,
    pub(crate) active_route: Option<RouteId>,
    pub(crate) routes: Vec<ShellRoute>,
    pub(crate) actions: Vec<ShellAction>,
    pub(crate) widgets: Vec<ShellWidget>,
    pub(crate) catalog: Vec<ChromeItemSpec>,
    pub(crate) layout: ChromeLayout,
    pub(crate) on_layout_change: LayoutChangeHandler,
    /// 布局编辑模式：条目可拖放，自身交互暂停。
    pub(crate) editing: bool,
    /// 已应用到 macOS 交通灯的纵向偏移；标题栏随文字放大撑高时重新居中。
    traffic_light_y: Pixels,
}

impl ShellView {
    /// 创建 shell，并使用传入顺序的首条路由作为初始页面；布局先取目录默认值，
    /// 宿主随后经 [`Self::apply_layout`] 应用偏好。
    pub fn new(
        translator: Entity<Translator>,
        routes: Vec<ShellRoute>,
        actions: Vec<ShellAction>,
        chrome: ShellChrome,
        cx: &mut Context<Self>,
    ) -> Self {
        let active_route = routes.first().map(|route| route.id);
        cx.observe(&translator, |_, _, cx| cx.notify()).detach();
        for route in &routes {
            if let Some(sidebar) = &route.sidebar {
                let route_id = route.id;
                cx.observe(sidebar, move |this, _, cx| {
                    if this.active_route == Some(route_id) {
                        cx.notify();
                    }
                })
                .detach();
            }
        }
        let ShellChrome {
            widgets,
            catalog,
            on_layout_change,
        } = chrome;
        Self {
            translator,
            active_route,
            routes,
            actions,
            widgets,
            layout: ChromeLayout::default_for(&catalog),
            catalog,
            on_layout_change,
            editing: false,
            traffic_light_y: crate::initial_traffic_light_y(),
        }
    }

    /// 切换到指定路由（宿主导航入口）。
    pub fn navigate(&mut self, route: RouteId, cx: &mut Context<Self>) {
        if self.active_route != Some(route) {
            self.active_route = Some(route);
            cx.notify();
        }
    }

    /// 按活动栏按钮 id 设置可选路由或动作的可见性（宿主偏好回流入口）；
    /// 隐藏当前活跃路由时自动切到首条可见路由。
    pub fn set_entry_visible(&mut self, button_id: &str, visible: bool, cx: &mut Context<Self>) {
        if let Some(route) = self.routes.iter_mut().find(|r| r.button_id == button_id) {
            if route.visible == visible {
                return;
            }
            route.visible = visible;
            let id = route.id;
            if !visible && self.active_route == Some(id) {
                self.active_route = self.routes.iter().find(|r| r.visible).map(|r| r.id);
            }
            cx.notify();
            return;
        }
        let Some(action) = self.actions.iter_mut().find(|a| a.button_id == button_id) else {
            return;
        };
        if action.visible == visible {
            return;
        }
        action.visible = visible;
        cx.notify();
    }

    /// 统一顶栏：macOS 交通灯 / Windows·Linux logo + 应用菜单，其后是顶栏左区、当前活跃路由的
    /// 插槽与顶栏右区；Windows·Linux 的窗口按钮由 `TitleBar` 自带。
    fn render_title_bar(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let theme = active_theme(cx);
        let spacing = theme.tokens().spacing;
        let extended = theme.extended().colors;
        let is_macos = cfg!(target_os = "macos");
        // macOS 交通灯占据左侧，不渲染 logo。
        let leading = (!is_macos).then(|| {
            h_flex()
                .h_full()
                .flex_none()
                .items_center()
                .child(img(APP_LOGO_PATH).size(px(16.)))
        });
        let slot = self.active_title_bar();
        let title_leading = self.render_title_zone(ChromeZone::TitleLeading, window, cx);
        let title_trailing = self.render_title_zone(ChromeZone::TitleTrailing, window, cx);
        let sidebar_toggle = self
            .active_route
            .and_then(|id| self.routes.iter().find(|route| route.id == id))
            .and_then(|route| route.sidebar.as_ref())
            .filter(|sidebar| sidebar.read(cx).is_available())
            .map(|sidebar| self.render_sidebar_toggle(sidebar, cx));
        let title_bar = TitleBar::new();
        #[cfg(not(target_os = "macos"))]
        let title_bar = title_bar.pl(spacing.sm);

        // 显式 `.bg` 覆盖 gpui-component 默认渐变；`.h` 经 refine_style 覆盖默认 34px。
        title_bar
            .h(crate::title_bar_height(cx))
            .bg(extended.chrome)
            .border_color(extended.hairline)
            .child(
                // 绝对定位铺满拖动区：标题行不参与 gpui-component 拖动区的内容宽度，窗口控制按钮不会被挤出。
                h_flex()
                    .absolute()
                    .inset_0()
                    .items_center()
                    .gap(spacing.sm)
                    .pr(if is_macos { spacing.md } else { spacing.sm })
                    .children(leading)
                    .children(sidebar_toggle)
                    .children(title_leading)
                    .child(
                        h_flex()
                            .h_full()
                            .flex_1()
                            .min_w_0()
                            .items_center()
                            .children(slot),
                    )
                    .children(title_trailing),
            )
    }

    fn render_sidebar_toggle(
        &self,
        sidebar: &Entity<SidebarState>,
        cx: &App,
    ) -> impl IntoElement + use<> {
        let key = if sidebar.read(cx).is_collapsed() {
            "expandSidebar"
        } else {
            "collapseSidebar"
        };
        let label = SharedString::from(self.translator.read(cx).text(key).to_owned());
        let state = sidebar.clone();
        div()
            .id("shell-sidebar-toggle-tooltip")
            .flex_none()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .tooltip({
                let label = label.clone();
                move |window, cx| Tooltip::new(label.clone()).build(window, cx)
            })
            .child(
                toolbar_action_button(
                    "shell-sidebar-toggle",
                    label,
                    Icon::new(FluxIcon::PanelRight)
                        .size(active_theme(cx).extended().icon.md)
                        .rotate(percentage(0.5)),
                    false,
                    false,
                    cx,
                )
                .on_click(move |_, _, cx| state.update(cx, |state, cx| state.toggle(cx))),
            )
    }

    /// 当前活跃路由挂载的顶栏插槽。
    fn active_title_bar(&self) -> Option<AnyView> {
        self.active_route
            .and_then(|active| self.routes.iter().find(|route| route.id == active))
            .and_then(|route| route.title_bar.clone())
    }

    /// 自绘动作视图的按钮位尺寸（视图按此尺寸绘制以与图标按钮对齐）。
    pub const ACTION_BUTTON_SIZE: Pixels = ACTIVITY_BUTTON_SIZE;

    fn active_content(&self) -> AnyElement {
        self.active_route
            .and_then(|active| self.routes.iter().find(|route| route.id == active))
            .map_or_else(
                || div().into_any_element(),
                |route| route.view.clone().into_any_element(),
            )
    }
}

impl Render for ShellView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        crate::sync_traffic_light(
            window,
            crate::title_bar_height(cx),
            &mut self.traffic_light_y,
        );
        let colors = active_theme(cx).tokens().colors;
        let title_bar = self.render_title_bar(window, cx);
        let banner = self.render_edit_banner(cx);
        let activity_bar = self.render_activity_bar(window, cx);
        let status_bar = self.render_status_bar(window, cx);
        v_flex()
            .size_full()
            .relative()
            .bg(colors.background)
            .text_color(colors.foreground)
            .on_key_down(cx.listener(Self::on_edit_key_down))
            .child(title_bar)
            .children(banner)
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .items_stretch()
                    .children(activity_bar)
                    .child(
                        v_flex()
                            .h_full()
                            .flex_1()
                            .min_w_0()
                            .min_h_0()
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .min_h_0()
                                    .child(self.active_content()),
                            )
                            .children(status_bar),
                    ),
            )
    }
}
