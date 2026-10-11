#!/usr/bin/env bash
# FluxDown RPM 打包（x64）：文件系统布局与 scripts/package_gpui_linux.sh 的 deb/Arch 一致。
#
# 四个可执行文件必须同目录：fluxdown-desktop 按 current_exe 同级找 fluxdown-agent
# （crates/app/src/service_bootstrap.rs），agent 同理找 fluxdownd（native/agent/src/supervisor.rs）
# 与 fluxdown_nmh（native/agent/src/nmh.rs）。所有 UI 资源已编译进二进制，无运行期资源目录。
#
# 用法：VERSION=0.5.6~rc.1 [RELEASE=1] BIN_DIR=target/release packaging/rpm/build_rpm.sh
#       VERSION 支持 semver 预发布（写入 RPM Version 时 '-' 换 '~'，如 0.5.6~rc.1 < 0.5.6）。
#       RELEASE 默认 1；CI 传 run_number 保证单调递增。
# 依赖：rpm-build。产物与 rpmbuild 工作区在 build/rpm/（gitignore）。
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
VERSION=${VERSION:?VERSION required}
RELEASE=${RELEASE:-1}
BIN_DIR=${BIN_DIR:?BIN_DIR required}
TOP="$REPO/build/rpm"
STAGE="$TOP/stage"
BINS=(fluxdown-desktop fluxdown-agent fluxdownd fluxdown_nmh)
DESKTOP_FILE="$REPO/packaging/linux/com.fluxdown.app.desktop"
ICON="$REPO/assets/logo/fluxdown_logo.png"

rm -rf "$STAGE"
mkdir -p "$STAGE/opt/fluxdown" "$STAGE/usr/bin" \
  "$STAGE/usr/share/applications" "$STAGE/usr/share/icons/hicolor/256x256/apps"

for bin in "${BINS[@]}"; do
  install -m 0755 "$BIN_DIR/$bin" "$STAGE/opt/fluxdown/$bin"
done

# Flutter 版自启条目（~/.config/autostart/FluxDown.desktop）固定执行 /opt/fluxdown/flux_down
# --silentStart；保留转发器与 deb/Arch 一致（native/agent/src/platform/autostart.rs 旧版迁移）。
cat >"$STAGE/opt/fluxdown/flux_down" <<'FWD'
#!/bin/sh
dir="$(dirname "$(readlink -f "$0")")"
if [ "$1" = "--silentStart" ]; then
  shift
  exec "$dir/fluxdown-agent" --autostart "$@"
fi
exec "$dir/fluxdown-desktop" "$@"
FWD
chmod 0755 "$STAGE/opt/fluxdown/flux_down"

# /usr/bin 符号链接：Linux current_exe 解析真实路径，兄弟查找不受影响。
ln -s /opt/fluxdown/fluxdown-desktop "$STAGE/usr/bin/fluxdown-desktop"
ln -s /opt/fluxdown/fluxdown-agent "$STAGE/usr/bin/fluxdown-agent"
install -m 0644 "$DESKTOP_FILE" "$STAGE/usr/share/applications/com.fluxdown.app.desktop"
install -m 0644 "$ICON" "$STAGE/usr/share/icons/hicolor/256x256/apps/com.fluxdown.app.png"

# RPM Version 里 '-' 必须写成 '~'（0.5.6~rc.1 < 0.5.6）；用 sed 替换，
# 避免 bash ${var/-/~} 对替换串做波浪号展开把 '~' 变成 $HOME。
RPM_VERSION=$(printf '%s\n' "$VERSION" | sed 's/-/~/')

mkdir -p "$TOP/rpmbuild/BUILD" "$TOP/rpmbuild/RPMS" "$TOP/rpmbuild/SRPMS"
rpmbuild -bb \
  --define "_topdir $TOP/rpmbuild" \
  --define "stage_dir $STAGE" \
  --define "_version $RPM_VERSION" \
  --define "_release $RELEASE" \
  --define "debug_package %{nil}" \
  "$REPO/packaging/rpm/fluxdown.spec"

ls -la "$TOP/rpmbuild/RPMS/x86_64/"
