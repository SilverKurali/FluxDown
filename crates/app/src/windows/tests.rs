use std::{cell::RefCell, collections::HashMap, collections::HashSet, rc::Rc};

use gpui::{
    App, AppContext as _, Context, Empty, Render, Subscription, TestApp, Window, WindowHandle,
    WindowOptions,
};

use super::{WindowKey, WindowRegistry, bounds::BoundsMemory};

struct TestView;

impl Render for TestView {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl gpui::IntoElement {
        Empty
    }
}

fn open(cx: &mut App, key: WindowKey) -> Option<WindowHandle<TestView>> {
    WindowRegistry::open_or_focus(cx, key, WindowOptions::default(), |_, cx| {
        cx.new(|_| TestView)
    })
}

fn app() -> TestApp {
    let mut app = TestApp::new();
    app.update(|cx| {
        gpui_component::init(cx);
        fluxdown_ui_theme::init(cx);
        let closed_sub = cx.on_window_closed(WindowRegistry::on_window_closed);
        cx.set_global(WindowRegistry {
            open: HashMap::new(),
            ids: HashMap::new(),
            confirming: HashSet::new(),
            bounds: Rc::new(RefCell::new(BoundsMemory::default())),
            _closed_sub: closed_sub,
            // These tests do not persist bounds or connect to an agent.
            _quit_sub: Subscription::new(|| {}),
        });
        // Keep a user window alive so closing settings does not exit the app.
        assert!(open(cx, WindowKey::Main).is_some());
    });
    app
}

#[test]
fn repeated_settings_open_from_its_own_window_keeps_one_instance() {
    let mut app = app();
    let settings = app.update(|cx| open(cx, WindowKey::Settings).unwrap());

    for _ in 0..3 {
        app.update(|cx| {
            settings
                .update(cx, |_, _, cx| {
                    assert!(open(cx, WindowKey::Settings).is_none());
                })
                .unwrap();
        });
        app.read(|cx| {
            assert_eq!(cx.windows().len(), 2);
            assert_eq!(WindowRegistry::open_count(cx), 2);
            assert_eq!(
                WindowRegistry::handle(cx, &WindowKey::Settings),
                Some(settings.into())
            );
            assert_eq!(
                WindowRegistry::key_of(cx, settings.window_id()),
                Some(WindowKey::Settings)
            );
            assert_eq!(cx.active_window(), Some(settings.into()));
        });
    }
}

#[test]
fn settings_open_from_another_window_focuses_existing_instance() {
    let mut app = app();
    let settings = app.update(|cx| open(cx, WindowKey::Settings).unwrap());
    app.update(|cx| {
        let main = WindowRegistry::handle(cx, &WindowKey::Main).unwrap();
        main.update(cx, |_, window, cx| {
            window.activate_window();
            assert!(open(cx, WindowKey::Settings).is_none());
        })
        .unwrap();
    });
    app.read(|cx| {
        assert_eq!(cx.windows().len(), 2);
        assert_eq!(cx.active_window(), Some(settings.into()));
    });
}

#[test]
fn closing_settings_before_deferred_focus_allows_clean_reopen() {
    let mut app = app();
    let settings = app.update(|cx| open(cx, WindowKey::Settings).unwrap());
    app.update(|cx| {
        settings
            .update(cx, |_, window, cx| {
                assert!(open(cx, WindowKey::Settings).is_none());
                window.remove_window();
            })
            .unwrap();
    });
    app.read(|cx| {
        assert_eq!(cx.windows().len(), 1);
        assert!(!WindowRegistry::is_open(cx, &WindowKey::Settings));
        assert_eq!(WindowRegistry::key_of(cx, settings.window_id()), None);
    });

    let reopened = app.update(|cx| open(cx, WindowKey::Settings).unwrap());
    assert_ne!(settings.window_id(), reopened.window_id());
    app.read(|cx| {
        assert_eq!(cx.windows().len(), 2);
        assert_eq!(
            WindowRegistry::handle(cx, &WindowKey::Settings),
            Some(reopened.into())
        );
    });
}
