#!/usr/bin/env bash
set -euo pipefail

# 打包 JustCPC 机房考试服务发行版（Windows + Linux）。
# 产物（在 release/ 下）：
#   ExamServer-<version>-windows/ ... + ExamServer-<version>-windows.zip
#   ExamServer-<version>-linux/   ... + ExamServer-<version>-linux.tar.gz
# 每个发行目录含：可执行文件、config.example.json、启停脚本、使用说明、README。
# 首次运行会在目录内自动生成 config.json（随机密钥）并打印初始管理员密码。
#
# 用法：./script/build-release.sh            （版本默认 0.1.0）
#       VERSION=0.2.0 ./script/build-release.sh

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$script_dir/.." && pwd)"
version="${VERSION:-0.1.0}"
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
    ( cd "$project_dir"; CGO_ENABLED=0 GOOS="$goos" GOARCH=amd64 \
        go build -trimpath -ldflags "-s -w" -o "$dir/$binname" ./src )
    cp "$project_dir/config.example.json" "$dir/config.example.json"
    cp "$project_dir/README.md" "$dir/README.md"
}

mkdir -p "$release_root"

# ---------- Windows ----------
build_platform windows ExamServer.exe
win="$release_root/ExamServer-$version-windows"
cat > "$win/start-exam.bat" <<'EOF'
@echo off
cd /d "%~dp0"
echo JustCPC Exam Server
echo 选手入口: http://本机IP:10293/    管理员入口: http://本机IP:10293/admin
ExamServer.exe
pause
EOF
cat > "$win/stop-exam.bat" <<'EOF'
@echo off
taskkill /IM ExamServer.exe /F
pause
EOF
cat > "$win/使用说明.txt" <<'EOF'
JustCPC 机房考试服务 —— 现场管理员
1. 把整个文件夹解压到任意可写目录（Windows 请勿放 Program Files）。
2. 双击 start-exam.bat 启动。首次运行会自动生成 config.json，并在窗口打印初始管理员账号密码。
3. 选手访问 http://本机IP:10293/ ，管理员访问 http://本机IP:10293/admin 。
4. 首次登录后请立即修改管理员密码。
5. 运行数据在 data/ 目录（首次运行自动创建）；备份时整包拷贝 data/ 即可。
EOF

# ---------- Linux ----------
build_platform linux justcpc-exam-server
lin="$release_root/ExamServer-$version-linux"
cat > "$lin/start-exam.sh" <<'EOF'
#!/usr/bin/env bash
cd "$(dirname "$0")"
exec ./justcpc-exam-server
EOF
cat > "$lin/stop-exam.sh" <<'EOF'
#!/usr/bin/env bash
pkill -f 'justcpc-exam-server' || true
EOF
chmod +x "$lin/start-exam.sh" "$lin/stop-exam.sh" "$lin/justcpc-exam-server"
cat > "$lin/使用说明.txt" <<'EOF'
JustCPC 机房考试服务 —— 现场管理员
1. 把整个文件夹解压到任意可写目录。
2. 运行 ./start-exam.sh 启动（或直接执行 ./justcpc-exam-server）。首次运行会自动生成 config.json，并打印初始管理员账号密码。
3. 选手访问 http://本机IP:10293/ ，管理员访问 http://本机IP:10293/admin 。
4. 首次登录后请立即修改管理员密码。
5. 运行数据在 data/ 目录（首次运行自动创建）；备份时整包拷贝 data/ 即可。
EOF

# ---------- 打包 ----------
python3 - "$release_root" "$version" <<'PY'
import os, sys, zipfile, tarfile
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

print("windows:", zip_path, os.path.getsize(zip_path), "bytes")
print("linux:  ", tgz_path, os.path.getsize(tgz_path), "bytes")
PY

printf '\n打包完成，产物在：%s\n' "$release_root"
ls -la "$release_root"
