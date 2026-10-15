//! 嗅探规则包存储：磁盘缓存 + 验签 + 按需后台刷新。
//!
//! 只在浏览器扩展发起 `sniff_rules` 请求时才可能触发刷新；没有请求就没有网络与磁盘写入
//! （AGENTS「空闲静默」）。查询永不等待刷新完成，直接返回当前已验证的缓存。

mod keys;
mod verify;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::http_client::LazyHttpClient;
use verify::{DocKind, KeySet, MAX_ENVELOPE_BYTES, VerifiedDoc, verify_envelope};

pub use verify::SniffRuleError;

const SOURCES: &[&str] = &[
    "https://raw.githubusercontent.com/zerx-lab/fluxdown-sniff-rules/main/dist/",
    "https://cdn.jsdelivr.net/gh/zerx-lab/fluxdown-sniff-rules@main/dist/",
];
const REFRESH_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const RETRY_INTERVAL: Duration = Duration::from_secs(30 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// 扩展已持有的各文档 sequence；只返回比它新的文档。
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Have {
    official: Option<u64>,
    community: Option<u64>,
    revocations: Option<u64>,
}

impl Have {
    const fn of(self, kind: DocKind) -> Option<u64> {
        match kind {
            DocKind::Official => self.official,
            DocKind::Community => self.community,
            DocKind::Revocations => self.revocations,
        }
    }
}

#[derive(Default)]
struct State {
    loaded: bool,
    docs: [Option<VerifiedDoc>; 3],
    last_attempt: Option<Instant>,
    last_fetch_unix: Option<u64>,
    last_error: Option<String>,
    refreshing: bool,
}

struct Inner {
    dir: PathBuf,
    keys: KeySet,
    sources: Vec<String>,
    http: LazyHttpClient,
    state: Mutex<State>,
}

pub struct SniffRuleStore {
    inner: Arc<Inner>,
}

impl SniffRuleStore {
    /// 生产构造：内置公钥与规则源；`dir` 为 `<agent_data_dir>/sniff-rules`。
    #[must_use]
    pub fn new(dir: PathBuf) -> Self {
        Self::build(
            dir,
            KeySet::production(),
            SOURCES.iter().map(|source| (*source).to_owned()).collect(),
        )
    }

    #[cfg(test)]
    fn with(dir: PathBuf, keys: KeySet, sources: Vec<String>) -> Self {
        Self::build(dir, keys, sources)
    }

    fn build(dir: PathBuf, keys: KeySet, sources: Vec<String>) -> Self {
        Self {
            inner: Arc::new(Inner {
                dir,
                keys,
                sources,
                http: LazyHttpClient::new(|| {
                    reqwest::Client::builder()
                        .timeout(REQUEST_TIMEOUT)
                        .user_agent(concat!("fluxdown-agent/", env!("CARGO_PKG_VERSION")))
                }),
                state: Mutex::new(State::default()),
            }),
        }
    }

    /// 按 C5 `sniff_rules` 应答构造 data：立即返回当前缓存，必要时在后台启动刷新。
    pub async fn query(&self, have: Have) -> Value {
        let mut state = self.inner.state.lock().await;
        if !state.loaded {
            self.inner.load_from_disk(&mut state).await;
            state.loaded = true;
        }
        let interval = if state.last_error.is_some() {
            RETRY_INTERVAL
        } else {
            REFRESH_INTERVAL
        };
        if !state.refreshing && state.last_attempt.is_none_or(|at| at.elapsed() >= interval) {
            state.refreshing = true;
            tokio::spawn(Arc::clone(&self.inner).refresh());
        }
        let newer = |kind: DocKind| {
            state.docs[kind.index()]
                .as_ref()
                .filter(|doc| have.of(kind).is_none_or(|known| doc.sequence > known))
                .map_or(Value::Null, |doc| doc.payload.clone())
        };
        json!({
            "official": newer(DocKind::Official),
            "community": newer(DocKind::Community),
            "revocations": newer(DocKind::Revocations),
            "status": {
                "lastFetchUnix": state.last_fetch_unix,
                "lastError": state.last_error,
            },
        })
    }

    #[cfg(test)]
    async fn refresh_now(&self) {
        {
            let mut state = self.inner.state.lock().await;
            if !state.loaded {
                self.inner.load_from_disk(&mut state).await;
                state.loaded = true;
            }
            state.refreshing = true;
        }
        Arc::clone(&self.inner).refresh().await;
    }
}

enum Fetched {
    Updated(VerifiedDoc),
    Current,
}

impl Inner {
    /// 重新验签磁盘上的每个文件；验签失败（被篡改 / 密钥轮换后失效）的文件删除。
    async fn load_from_disk(&self, state: &mut State) {
        for kind in DocKind::ALL {
            let path = self.dir.join(kind.file_name());
            let bytes = match tokio::fs::read(&path).await {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    tracing::warn!(file = kind.file_name(), error = %error, "could not read sniff rule cache");
                    continue;
                }
            };
            match verify_envelope(&bytes, kind, &self.keys) {
                Ok(doc) => state.docs[kind.index()] = Some(doc),
                Err(error) => {
                    tracing::warn!(file = kind.file_name(), error = %error, "discarding invalid sniff rule cache");
                    if let Err(error) = tokio::fs::remove_file(&path).await {
                        tracing::warn!(file = kind.file_name(), error = %error, "could not delete invalid sniff rule cache");
                    }
                }
            }
        }
    }

    async fn refresh(self: Arc<Self>) {
        let mut errors = Vec::new();
        let mut fetched_any = false;
        for kind in DocKind::ALL {
            let have = self.state.lock().await.docs[kind.index()]
                .as_ref()
                .map(|doc| doc.sequence);
            match self.fetch_kind(kind, have).await {
                Ok(Fetched::Current) => fetched_any = true,
                Ok(Fetched::Updated(doc)) => {
                    match write_atomic(&self.dir, kind.file_name(), &doc.envelope).await {
                        Ok(()) => {
                            fetched_any = true;
                            self.state.lock().await.docs[kind.index()] = Some(doc);
                        }
                        Err(error) => errors.push(format!("{}: {error}", kind.file_name())),
                    }
                }
                Err(error) => errors.push(format!("{}: {error}", kind.file_name())),
            }
        }
        let mut state = self.state.lock().await;
        state.refreshing = false;
        state.last_attempt = Some(Instant::now());
        state.last_error = (!errors.is_empty()).then(|| errors.join("; "));
        if fetched_any {
            state.last_fetch_unix = Some(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(0, |elapsed| elapsed.as_secs()),
            );
        }
    }

    /// 按源顺序取第一个 2xx 且验签通过且不回滚的文档。
    async fn fetch_kind(
        &self,
        kind: DocKind,
        have: Option<u64>,
    ) -> Result<Fetched, SniffRuleError> {
        let mut last_error = SniffRuleError::Http("no sources configured".to_owned());
        for source in &self.sources {
            let url = format!("{source}{}", kind.file_name());
            let bytes = match self.download(&url).await {
                Ok(bytes) => bytes,
                Err(error) => {
                    last_error = error;
                    continue;
                }
            };
            let doc = match verify_envelope(&bytes, kind, &self.keys) {
                Ok(doc) => doc,
                Err(error) => {
                    last_error = error;
                    continue;
                }
            };
            match have {
                Some(have) if doc.sequence < have => {
                    last_error = SniffRuleError::Rollback {
                        have,
                        got: doc.sequence,
                    };
                }
                Some(have) if doc.sequence == have => return Ok(Fetched::Current),
                _ => return Ok(Fetched::Updated(doc)),
            }
        }
        Err(last_error)
    }

    /// 流式累计响应体，超过信封上限即中止。错误串不含 URL（可能带查询参数）。
    async fn download(&self, url: &str) -> Result<Vec<u8>, SniffRuleError> {
        let http_error =
            |error: reqwest::Error| SniffRuleError::Http(error.without_url().to_string());
        let client = self
            .http
            .get()
            .await
            .map_err(|error| SniffRuleError::Http(error.to_string()))?;
        let mut response = client.get(url).send().await.map_err(http_error)?;
        let status = response.status();
        if !status.is_success() {
            return Err(SniffRuleError::Http(format!("status {}", status.as_u16())));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(http_error)? {
            if body.len() + chunk.len() > MAX_ENVELOPE_BYTES {
                return Err(SniffRuleError::TooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }
}

/// 先写 `<name>.tmp` 再 rename，崩溃时不会留下半截缓存。
async fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), SniffRuleError> {
    let io = |error: std::io::Error| SniffRuleError::Io(error.to_string());
    tokio::fs::create_dir_all(dir).await.map_err(io)?;
    let temp = dir.join(format!("{name}.tmp"));
    tokio::fs::write(&temp, bytes).await.map_err(io)?;
    tokio::fs::rename(&temp, dir.join(name)).await.map_err(io)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::Router;
    use axum::extract::State as AxumState;
    use axum::http::StatusCode;
    use axum::routing::get;
    use ed25519_dalek::SigningKey;
    use serde_json::json;
    use tokio::sync::Mutex;

    use super::verify::sign_envelope;
    use super::*;

    type Served = Arc<Mutex<Option<Vec<u8>>>>;

    fn signing() -> SigningKey {
        SigningKey::from_bytes(&[7_u8; 32])
    }

    fn keys() -> KeySet {
        KeySet::new(
            vec![("rel".to_owned(), signing().verifying_key().to_bytes())],
            Vec::new(),
        )
    }

    fn official(sequence: u64) -> Vec<u8> {
        let payload = serde_json::to_vec(&json!({
            "format": "fluxdown-sniff-pack", "packId": "official", "sequence": sequence,
            "engine": 1, "issuedAt": "2026-10-01T00:00:00Z", "rules": [],
        }))
        .expect("pack json");
        sign_envelope(&payload, "rel", &signing())
    }

    /// 只提供 `official.json`；其余文件 404。返回 `dist/` 源前缀与可替换的文档槽。
    async fn serve(initial: Vec<u8>) -> (String, Served) {
        let served: Served = Arc::new(Mutex::new(Some(initial)));
        let app = Router::new()
            .route(
                "/dist/official.json",
                get(|AxumState(served): AxumState<Served>| async move {
                    match served.lock().await.clone() {
                        Some(bytes) => Ok(bytes),
                        None => Err(StatusCode::NOT_FOUND),
                    }
                }),
            )
            .with_state(Arc::clone(&served));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, app).await {
                tracing::warn!(error = %error, "test sniff rule server stopped");
            }
        });
        (format!("http://{address}/dist/"), served)
    }

    fn temp_dir() -> tempfile_dir::Dir {
        tempfile_dir::Dir::new()
    }

    /// 无额外依赖的临时目录（agent 未依赖 tempfile）。
    mod tempfile_dir {
        use std::path::{Path, PathBuf};

        pub(super) struct Dir(PathBuf);

        impl Dir {
            pub(super) fn new() -> Self {
                let path = std::env::temp_dir()
                    .join(format!("fluxdown-sniff-test-{}", uuid::Uuid::new_v4()));
                Self(path)
            }

            pub(super) fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for Dir {
            fn drop(&mut self) {
                if let Err(error) = std::fs::remove_dir_all(&self.0)
                    && error.kind() != std::io::ErrorKind::NotFound
                {
                    eprintln!("could not remove test dir: {error}");
                }
            }
        }
    }

    #[tokio::test]
    async fn first_query_is_empty_then_refresh_delivers_pack() {
        let (source, _served) = serve(official(5)).await;
        let dir = temp_dir();
        let store = SniffRuleStore::with(dir.path().to_path_buf(), keys(), vec![source]);

        let first = store.query(Have::default()).await;
        assert!(first["official"].is_null());

        let mut delivered = Value::Null;
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let reply = store.query(Have::default()).await;
            if !reply["official"].is_null() {
                delivered = reply;
                break;
            }
        }
        assert_eq!(delivered["official"]["sequence"], 5);
        assert!(delivered["community"].is_null());
        assert!(delivered["status"]["lastFetchUnix"].is_u64());
        assert!(dir.path().join("official.json").exists());
    }

    #[tokio::test]
    async fn have_current_sequence_returns_null() {
        let (source, _served) = serve(official(5)).await;
        let dir = temp_dir();
        let store = SniffRuleStore::with(dir.path().to_path_buf(), keys(), vec![source]);
        store.refresh_now().await;

        let current = Have {
            official: Some(5),
            ..Have::default()
        };
        assert!(store.query(current).await["official"].is_null());
        let stale = Have {
            official: Some(4),
            ..Have::default()
        };
        assert_eq!(store.query(stale).await["official"]["sequence"], 5);
    }

    #[tokio::test]
    async fn server_rollback_keeps_old_pack_and_reports_error() {
        let (source, served) = serve(official(5)).await;
        let dir = temp_dir();
        let store = SniffRuleStore::with(dir.path().to_path_buf(), keys(), vec![source]);
        store.refresh_now().await;

        *served.lock().await = Some(official(3));
        store.refresh_now().await;

        let reply = store.query(Have::default()).await;
        assert_eq!(reply["official"]["sequence"], 5);
        let error = reply["status"]["lastError"].as_str().expect("lastError");
        assert!(error.contains("Rollback"), "{error}");
    }

    #[tokio::test]
    async fn tampered_disk_file_is_deleted_on_load() {
        let dir = temp_dir();
        std::fs::create_dir_all(dir.path()).expect("mkdir");
        let path = dir.path().join("official.json");
        std::fs::write(&path, official(5)).expect("write");
        // 篡改：payload 解码后内容变化，签名不再匹配。
        let mut tampered = official(5);
        let needle = b"\"payload\":\"";
        let at = tampered
            .windows(needle.len())
            .position(|window| window == needle)
            .expect("payload field")
            + needle.len();
        tampered[at] = if tampered[at] == b'A' { b'B' } else { b'A' };
        std::fs::write(&path, tampered).expect("write tampered");

        let store = SniffRuleStore::with(dir.path().to_path_buf(), keys(), Vec::new());
        let reply = store.query(Have::default()).await;
        assert!(reply["official"].is_null());
        assert!(!path.exists());
    }
}
