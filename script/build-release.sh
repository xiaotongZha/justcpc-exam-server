#!/usr/bin/env bash
set -euo pipefail

# 打包 JustCPC 机房考试服务发行版（Windows + Linux）。
# 产物（在 build/release/ 下）：
#   justcpc-exam-server-<version>-windows-amd64/ ... + justcpc-exam-server-<version>-windows-amd64.zip
#   justcpc-exam-server-<version>-linux-amd64/   ... + justcpc-exam-server-<version>-linux-amd64.tar.gz
# Windows 目录含可执行文件、config.json 与使用说明；Linux 另含三个管理入口。
# 首次运行补全留空的密钥与初始管理员密码，data/ 自动创建。
#
# 用法：./script/build-release.sh            （版本默认 1.0.1）
#       VERSION=1.0.1 ./script/build-release.sh

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$script_dir/.." && pwd)"
version="${VERSION:-1.0.1}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf 'Invalid VERSION.\n' >&2; exit 2; }
release_root="$project_dir/build/release"

if ! command -v go >/dev/null 2>&1; then
    printf 'go 工具链未安装，无法打包。\n' >&2
    exit 1
fi

build_platform() {
    local goos="$1" binname="$2"
    local dir="$release_root/justcpc-exam-server-$version-$goos-amd64"
    printf '==> 编译 %s/%s\n' "$goos" "amd64"
    rm -rf "$dir"
    mkdir -p "$dir"
    local build_flags="-s -w"
    if [[ "$goos" == "windows" ]]; then build_flags="$build_flags -H windowsgui"; fi
    ( cd "$project_dir"; CGO_ENABLED=0 GOOS="$goos" GOARCH=amd64 \
        go build -trimpath -ldflags "$build_flags" -o "$dir/$binname" ./src )
    cp "$project_dir/config/config.example.json" "$dir/config.json"
    chmod 600 "$dir/config.json"
}

mkdir -p "$release_root"

# ---------- Windows ----------
build_platform windows justcpc-exam-server.exe
win="$release_root/justcpc-exam-server-$version-windows-amd64"
cat > "$win/使用说明.txt" <<'EOF'
JustCPC 机房考试服务
1. 完整解压到可写目录（勿放 Program Files）。首次启动前，可编辑 config.json 设置端口、管理员账号/初始密码、试题解压密码。
2. 双击 justcpc-exam-server.exe，点击“打开管理页面”。留空的初始密码与会话密钥首次启动自动生成并保存，data/ 自动创建。
3. 初始管理员账号密码、当前试题解压密码在启动窗口显示，解压密码开考时告知考生。
4. 修改端口（listen）、初始管理员密码（admin_password）或解压密码（statement_password）：先点击“停止并退出”，修改 config.json 后重新启动。初始密码仅首次创建账号生效，已有账号请在管理页“系统设置”修改密码。
5. 考生访问 http://本机IP:10293/；管理员访问 http://本机IP:10293/admin（端口以配置为准）。无法连接时检查防火墙和考场网络。
6. 管理页“考场总览”导入 OJ 导出的考试包，设定考试时间；考后导出提交包交回 OJ。
7. 最小化窗口不影响考试；停止服务用“停止并退出”。日志为 exam-server.log。
8. 升级先停止服务，保留 data/ 和 config.json，直接替换 EXE，不复制数据或保留旧版本。
EOF

# ---------- Linux ----------
build_platform linux justcpc-exam-server
lin="$release_root/justcpc-exam-server-$version-linux-amd64"
chmod +x "$lin/justcpc-exam-server"
cat > "$lin/使用说明.txt" <<'EOF'
JustCPC 机房考试服务
1. 完整解压到可写目录。首次启动前，可编辑 config.json 设置端口、管理员账号/初始密码、试题解压密码。
2. 执行从仓库下载的 install.sh 安装最新版，按提示输入 sudo 密码；服务后台运行、开机自启。./install.sh --logs 查看初始密码、解压密码与实时日志（Ctrl+C 退出日志）。
3. 考生访问 http://本机IP:10293/，管理员访问 http://本机IP:10293/admin（端口以配置为准）。
4. 初始管理员账号密码、当前试题解压密码在服务日志显示，解压密码开考时告知考生。
5. 修改 config.json 后运行 ./install.sh --restart。初始密码 admin_password 仅首次创建账号生效，已有账号请在管理页“系统设置”修改密码。
6. 管理页“考场总览”导入 OJ 导出的考试包，设定考试时间；考后导出提交包交回 OJ。
7. ./update.sh 检查新版，确认后原地升级，不生成备份；./uninstall.sh 卸载时询问是否删除配置和用户数据，默认保留；--keep-data 直接保留，--delete-data 明确删除（无法恢复）。
EOF

# Linux exposes only install / uninstall / update; Windows keeps its native launcher.
cp "$project_dir/"{install,update,uninstall}.sh "$lin/"
mkdir -p "$lin/script"
cp "$project_dir/script/register-service.sh" "$lin/script/"
printf '%s\n' "$version" > "$lin/.version"
chmod +x "$lin/"*.sh "$lin/script/"*.sh

# ---------- 打包 ----------
(cd "$release_root"; zip -qr "justcpc-exam-server-$version-windows-amd64.zip" "justcpc-exam-server-$version-windows-amd64"; tar -czf "justcpc-exam-server-$version-linux-amd64.tar.gz" "justcpc-exam-server-$version-linux-amd64"; sha256sum "justcpc-exam-server-$version-windows-amd64.zip" > "justcpc-exam-server-$version-windows-amd64.zip.sha256"; sha256sum "justcpc-exam-server-$version-linux-amd64.tar.gz" > "justcpc-exam-server-$version-linux-amd64.tar.gz.sha256")
printf '\n打包完成，产物在：%s\n' "$release_root"
