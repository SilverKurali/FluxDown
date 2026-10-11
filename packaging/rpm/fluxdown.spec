# FluxDown RPM spec —— 文件系统布局与 scripts/package_gpui_linux.sh 的 deb/Arch 一致：
# /opt/fluxdown 四个二进制 + flux_down 转发器、/usr/bin 符号链接、XDG 桌面项与图标。
# agent 的更新检查按 /opt/fluxdown 识别包管理安装（native/agent/src/update/）。
# 构建入口见同目录 build_rpm.sh（先 stage 文件，再 rpmbuild）。
# 本 fork 由 .github/workflows/fork-rpm.yml 在 Ubuntu runner 上构建（无 dist tag）。
Name:           fluxdown
Version:        %{_version}
Release:        %{_release}%{?dist}
Summary:        Free IDM-alternative download manager
License:        AGPL-3.0-only
URL:            https://fluxdown.zerx.dev
BuildArch:      x86_64

# ELF NEEDED 由 rpmbuild 自动生成；这里再显式声明顶层依赖兜底（CI 在 Ubuntu 上构建，
# 名称按 Fedora 包名书写），保证 dnf 安装时依赖可解析。
Requires:       gtk3, glib2, cairo, gdk-pixbuf2, pango, atk
Requires:       alsa-lib, fontconfig, freetype
Requires:       libxkbcommon, libxkbcommon-x11, libX11, libxcb, wayland
Requires:       dbus-libs, vulkan-loader, sqlite-libs
Requires:       libayatana-appindicator-gtk3, xdotool
Requires(post): desktop-file-utils, gtk3
Recommends:     xdg-utils, mesa-vulkan-drivers

%description
FluxDown is a Rust-powered, open-source download manager (free IDM alternative).
Supports HTTP/HTTPS/FTP, BitTorrent magnet links, and HLS/DASH streaming with
multi-threaded acceleration and seamless browser integration.

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}
cp -a %{stage_dir}/opt %{stage_dir}/usr %{buildroot}/

%files
/opt/fluxdown
/usr/bin/fluxdown-desktop
/usr/bin/fluxdown-agent
/usr/share/applications/com.fluxdown.app.desktop
/usr/share/icons/hicolor/256x256/apps/com.fluxdown.app.png

%post
if [ -x /usr/bin/update-desktop-database ]; then update-desktop-database -q || : ; fi
if [ -x /usr/bin/gtk-update-icon-cache ]; then gtk-update-icon-cache -qf %{_datadir}/icons/hicolor || : ; fi

%postun
if [ -x /usr/bin/gtk-update-icon-cache ]; then gtk-update-icon-cache -qf %{_datadir}/icons/hicolor || : ; fi

%changelog
