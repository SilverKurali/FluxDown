//! dev 插件重新加载：manifest 只在加载时解析，改动后须经 `reload_dev` 生效；
//! 校验失败保留 dev 登记与启停状态，修好后可再次重载恢复。
//!
//! 仅 `plugins` feature 下编译运行。

#![cfg(feature = "plugins")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::Path;
use std::sync::Arc;

use fluxdown_engine::bt_config::BtConfig;
use fluxdown_engine::plugin::PluginError;
use fluxdown_engine::proxy_config::ProxyConfig;
use fluxdown_engine::{Engine, EngineConfig, NoopSelection, NoopSink};

const IDENTITY: &str = "tester@reload";

fn uniq() -> String {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{}", std::process::id(), n)
}

async fn make_engine(work: &Path) -> Engine {
    let cfg = EngineConfig {
        max_concurrent: 4,
        speed_limit_bps: 0,
        upload_limit_bps: 0,
        default_save_dir: work.to_string_lossy().into_owned(),
        app_data_dir: work.to_string_lossy().into_owned(),
        bt_config: BtConfig::default(),
        proxy_config: ProxyConfig::default(),
        user_agent: String::new(),
        data_dir_override: Some(work.to_path_buf()),
        database_url: None,
    };
    Engine::new(cfg, Arc::new(NoopSink), Arc::new(NoopSelection))
        .await
        .expect("engine")
}

async fn write_manifest(dir: &Path, version: &str) {
    let manifest = format!(
        r#"{{
      "identity": "{IDENTITY}",
      "name": "Reload Test",
      "version": "{version}",
      "permissions": ["auth"],
      "auth": {{ "entry": "auth.js" }}
    }}"#
    );
    tokio::fs::write(dir.join("manifest.json"), manifest)
        .await
        .expect("write manifest");
}

async fn write_script(dir: &Path, source: &str) {
    tokio::fs::write(dir.join("auth.js"), source)
        .await
        .expect("write auth.js");
}

const VALID_SCRIPT: &str =
    r#"globalThis.authenticate = async (ctx) => JSON.stringify({ status: "success" });"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reload_dev_applies_manifest_edits_and_keeps_registration_on_failure() {
    let work = std::env::temp_dir().join(format!("fluxdown-reload-dev-{}", uniq()));
    let src = work.join("dev-src");
    tokio::fs::create_dir_all(&src).await.expect("mkdir");
    write_manifest(&src, "1.0.0").await;
    write_script(&src, VALID_SCRIPT).await;

    let engine = make_engine(&work).await;
    let pm = engine.manager.plugin_manager().expect("pm installed");
    pm.install_dev(&src).await.expect("install dev plugin");
    pm.set_enabled(IDENTITY, false).await.expect("disable");

    let version = |plugins: &[fluxdown_engine::plugin::PluginInfo]| {
        plugins
            .iter()
            .find(|p| p.identity == IDENTITY)
            .map(|p| (p.version.clone(), p.load_status.clone(), p.enabled))
    };

    // manifest 改动在重载前不可见，重载后生效；手动禁用状态不被覆盖。
    write_manifest(&src, "1.1.0").await;
    assert_eq!(version(&pm.list().await).unwrap().0, "1.0.0");
    pm.reload_dev(IDENTITY).await.expect("reload");
    assert_eq!(
        version(&pm.list().await),
        Some(("1.1.0".to_owned(), "Loaded".to_owned(), false))
    );

    // 脚本语法错误：重载报错，但 dev 登记保留（插件仍在列表里）。
    write_script(&src, "globalThis.authenticate = (;").await;
    let err = pm.reload_dev(IDENTITY).await.expect_err("broken script");
    assert!(matches!(err, PluginError::CompileFailed(_)), "got {err:?}");
    assert!(version(&pm.list().await).is_some());

    // manifest 损坏：列表转为加载失败并回报原因；修好后重载恢复。
    tokio::fs::write(src.join("manifest.json"), "{")
        .await
        .expect("corrupt manifest");
    let err = pm.reload_dev(IDENTITY).await.expect_err("broken manifest");
    assert!(matches!(err, PluginError::LoadFailed(_)), "got {err:?}");
    assert_eq!(version(&pm.list().await).unwrap().1, "Failed");

    write_manifest(&src, "1.2.0").await;
    write_script(&src, VALID_SCRIPT).await;
    pm.reload_dev(IDENTITY).await.expect("reload after fix");
    assert_eq!(
        version(&pm.list().await),
        Some(("1.2.0".to_owned(), "Loaded".to_owned(), false))
    );

    // 非 dev 标识拒绝。
    let err = pm.reload_dev("nobody@none").await.expect_err("not dev");
    assert!(matches!(err, PluginError::NotDevPlugin(_)), "got {err:?}");

    if let Err(error) = tokio::fs::remove_dir_all(&work).await
        && error.kind() != std::io::ErrorKind::NotFound
    {
        eprintln!("best-effort test directory cleanup: {error}");
    }
}
