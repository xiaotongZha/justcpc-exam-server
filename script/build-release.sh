#!/usr/bin/env bash
set -euo pipefail

# 打包 JustCPC 机房考试服务发行版（Windows + Linux）。
# 产物（在 release/ 下）：
#   ExamServer-<version>-windows/ ... + ExamServer-<version>-windows.zip
#   ExamServer-<version>-linux/   ... + ExamServer-<version>-linux.tar.gz
# 每个发行目录含可执行文件、config.json 与使用说明。
# 首次运行补全留空的密钥与初始管理员密码，data/ 自动创建。
#
# 用法：./script/build-release.sh            （版本默认 1.0.0）
#       VERSION=1.0.0 ./script/build-release.sh

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$script_dir/.." && pwd)"
version="${VERSION:-1.0.0}"
release_root="$project_dir/release"

if ! command -v go >/dev/null 2>&1; then
    printf 'go 工具链未安装，无法打包。\n' >&2
    exit 1
fi

rand_text() { head -c "${1:-48}" /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }

build_platform() {
    local goos="$1" binname="$2"
    local dir="$release_root/ExamServer-$version-$goos"
    printf '==> 编译 %s/%s\n' "$goos" "amd64"
    rm -rf "$dir"
    mkdir -p "$dir"
    local build_flags="-s -w"
    if [[ "$goos" == "windows" ]]; then build_flags="$build_flags -H windowsgui"; fi
    ( cd "$project_dir"; CGO_ENABLED=0 GOOS="$goos" GOARCH=amd64 \
        go build -trimpath -ldflags "$build_flags" -o "$dir/$binname" ./src )
    cp "$project_dir/config.example.json" "$dir/config.json"
    chmod 600 "$dir/config.json"
}

mkdir -p "$release_root"

# ---------- Windows ----------
build_platform windows ExamServer.exe
win="$release_root/ExamServer-$version-windows"
cat > "$win/使用说明.txt" <<'EOF'
JustCPC 机房考试服务
1. 完整解压到可写目录（勿放 Program Files）。首次启动前，可编辑 config.json 设置端口、管理员账号/初始密码、试题解压密码。
2. 双击 ExamServer.exe，点击“打开管理页面”。留空的初始密码与会话密钥首次启动自动生成并保存，data/ 自动创建。
3. 初始管理员账号密码、当前试题解压密码在启动窗口显示，解压密码开考时告知考生。
4. 修改端口（listen）、初始管理员密码（admin_password）或解压密码（statement_password）：先点击“停止并退出”，修改 config.json 后重新启动。初始密码仅首次创建账号生效，已有账号请在管理页“系统设置”修改密码。
5. 考生访问 http://本机IP:10293/；管理员访问 http://本机IP:10293/admin（端口以配置为准）。无法连接时检查防火墙和考场网络。
6. 管理页“考场总览”导入 OJ 导出的考试包，设定考试时间；考后导出提交包交回 OJ。
7. 最小化窗口不影响考试；停止服务用“停止并退出”。日志为 exam-server.log。
8. 升级先停止服务，保留 data/ 和 config.json，仅替换 EXE；备份需同时保存 data/ 和 config.json。
EOF

# ---------- Linux ----------
build_platform linux justcpc-exam-server
lin="$release_root/ExamServer-$version-linux"
chmod +x "$lin/justcpc-exam-server"
cat > "$lin/使用说明.txt" <<'EOF'
JustCPC 机房考试服务
1. 完整解压到可写目录。首次启动前，可编辑 config.json 设置端口、管理员账号/初始密码、试题解压密码。
2. 在解压目录运行 ./justcpc-exam-server，保持终端运行；Ctrl+C 停止。留空的初始密码与会话密钥首次启动自动生成并保存，data/ 自动创建。
3. 考生访问 http://本机IP:10293/，管理员访问 http://本机IP:10293/admin（端口以配置为准）。
4. 初始管理员账号密码、当前试题解压密码在启动终端显示，解压密码开考时告知考生。
5. 修改端口（listen）、初始管理员密码（admin_password）或解压密码（statement_password）：先停止服务，修改 config.json 后重新启动。初始密码仅首次创建账号生效，已有账号请在管理页“系统设置”修改密码。
6. 管理页“考场总览”导入 OJ 导出的考试包，设定考试时间；考后导出提交包交回 OJ。
7. 升级先停止服务，保留 data/ 和 config.json，仅替换可执行文件；备份需同时保存 data/ 和 config.json。
EOF

# ---------- 打包 ----------
python3 - "$release_root" "$version" <<'PY'
import os, sys, zipfile, tarfile, hashlib
root, version = sys.argv[1], sys.argv[2]
win = os.path.join(root, f"ExamServer-{version}-windows")
lin = os.path.join(root, f"ExamServer-{version}-linux")

zip_path = os.path.join(root, f"ExamServer-{version}-windows.zip")
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
    for base, _, files in os.walk(win):
        for name in files:
            full = os.path.join(base, name)
            z.write(full, os.path.relpath(full, root))

tgz_path = os.path.join(root, f"ExamServer-{version}-linux.tar.gz")
with tarfile.open(tgz_path, "w:gz") as t:
    t.add(lin, arcname=os.path.basename(lin))

for archive in (zip_path, tgz_path):
    digest = hashlib.sha256()
    with open(archive, "rb") as package:
        for chunk in iter(lambda: package.read(1024 * 1024), b""):
            digest.update(chunk)
    with open(archive + ".sha256", "w") as checksum:
        checksum.write(digest.hexdigest() + "  " + os.path.basename(archive) + "\n")

print("windows:", zip_path, os.path.getsize(zip_path), "bytes")
print("linux:  ", tgz_path, os.path.getsize(tgz_path), "bytes")
PY

printf '\n打包完成，产物在：%s\n' "$release_root"
ls -la "$release_root"
