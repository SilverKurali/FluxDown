---
type: always_apply
---
<!-- 由 .omp/ 生成（python3 .augment/sync_from_omp.py），请改 .omp 源文件 -->

该命令属于 FluxDown 项目禁令：

- `cargo test --workspace`：禁止全量跑。用 `cargo nextest run -p <crate> <filter>` 或 `cargo test -p <crate> -- <filter>` 精准跑。静态门禁不同：使用 `cargo clippy --workspace --exclude fluxdown_server --all-targets -- -D warnings`，含测试目标，冻结的 `native/server` 不构建。
- 推送 `v*` tag 会触发 GitHub Actions 全平台发布流水线，必须由用户明确要求后执行。
- 用 `-A` / `--allow` 关闭 todo、unimplemented、忽错或 unsafe 边界 lint（unsafe_op_in_unsafe_fn / undocumented_unsafe_blocks），或用 `--cap-lints allow/warn` 降低门禁：修复实现及安全论证，不用命令行消音。

请换用合规命令后继续。
