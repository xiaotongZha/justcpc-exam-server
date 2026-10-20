# justcpc-exam-server 开发说明

面向**离线机房**的局域网考试服务：考生用浏览器登录、下载题面、提交代码；现场管理员导入考试包、控制考试、导出提交包，交给赛后评测系统。

- **单文件、无外部依赖**：纯 Go 后端 + 内嵌前端，SQLite 数据库，跨 Windows / Linux。
- **离线可用**：考试期间只需机房局域网，不访问公网。
- **只收不判**：本服务不评测、不显示分数与排名；产出为可导入评测系统的**提交包**。
- 通过**考试包导入 / 提交包导出**与赛后评测系统交接，不共享数据库。

## 页面与操作

- 考生端提供登录、考生须知、候考、题目总览、代码提交、有效提交记录与交卷回执；暂停或结束时，当前页面内的代码仍可查看、复制。“试题下载”间隔为 5 秒，重复点击会先由页面拦截提示。
- 代码保存成功弹窗确认，返回题目总览并清空该题草稿；保存失败保留代码。每人每题仅保留最后一份有效代码，切换语言也会替换原代码。**保存不代表判题通过**。提前交卷后无法重新登录，已有会话同时失效。
- 管理端按考场总览、考生管理、提交记录、考生须知、系统设置组织；支持学号/姓名查找、状态筛选、语言筛选与须知实时预览。考生、提交及操作记录均支持分页，每页可选 10/20/50/100 条。
- “导入考试包”和“导出提交包”放在考场总览标题旁，不在其他标签页重复展示。未导入时，首页可直接选择或拖入考试包；校验确认后自动进入时间设置。生成提交包后先显示文件与交回 OJ 的说明，点击“知道了”才触发浏览器下载；生成期间禁止重复请求。
- 在考场总览展开考试时间卡片：选择日期，直接输入 `09:00` 或 `0900`，也可用 2／3／4／5 小时时长快捷补齐结束时间。统一按北京时间保存；切换管理页面、收起卡片或点击“刷新状态”会保留未保存内容，刷新浏览器或退出登录会清除草稿。“重新开考”使用同样的时间设置，默认保留先前提交。
- 保留比赛标志、校徽与协会会徽，使用系统字体；图片、图标和脚本全部内嵌，无需公网。页面修改后需重启源码服务，或重新构建并替换发行版可执行文件。
- 新部署预填充已确认的八条考生须知；包含“！！！”的条目在考生端及管理端预览中标红加粗。
- 当前页面内的代码草稿与未保存须知可在页面内切换时保留；刷新浏览器、关闭页面或退出登录前，请保存需要的内容。

## 快速开始（现场管理员）

v1.0.0：[GitHub](https://github.com/xiaotongZha/justcpc-exam-server/releases/tag/v1.0.0) · [Gitee](https://gitee.com/zhaxt/justcpc-exam-server/releases/tag/v1.0.0)

1. 把发行包解压到**任意可写目录**（Windows 请勿放 `Program Files`）。首次启动前，可编辑包内的 `config.json` 设置端口、管理员账号/初始密码及试题解压密码。
2. 启动：
   - Windows：双击 `justcpc-exam-server.exe`，在启动窗口点击“打开管理页面”；重复双击唤起已有实例
   - Linux：在解压目录运行 `./justcpc-exam-server`，按 `Ctrl+C` 停止
3. 浏览器访问：
   - 考生入口 `http://<本机IP>:10293/`
   - 管理员入口 `http://<本机IP>:10293/admin`
4. 留空的初始管理员密码及会话密钥首次启动自动生成并保存；已填写的值原样保留。管理员初始凭据及当前试题解压密码在 Windows 启动窗口 / Linux 终端显示。**首次登录后请修改密码。**

发行包仅含可执行文件、`config.json` 与使用说明。当前试题解压密码在 Windows 启动窗口 / Linux 启动终端显示。修改端口或解压密码等配置，先停止服务，修改 `config.json` 后重新启动。`admin_password` 仅在首次创建管理员时生效，已有账号在管理页“系统设置”中修改密码。

Windows 最小化窗口会继续运行，关闭窗口会确认停止服务。日志为 `exam-server.log`；需要命令行运行时使用 `justcpc-exam-server.exe --console`。Linux 保持命令行运行。

## 目录与数据

运行数据默认在配置文件旁的 `data/`，首次运行自动创建。Windows 默认读取 EXE 旁的配置，Linux 默认读取当前目录配置；`--config <路径>` 可指定配置，相对数据路径以配置所在目录为基准：

```
data/
├── exam.sqlite        # SQLite 主库（考试/题目/考生/提交/审计）
└── store/
    ├── contest-statements/   # 比赛题面 PDF
    ├── submissions/code-*/     # 考生提交源码
    └── imports/              # 导入暂存
```

- 覆盖升级：**保留 `data/` 与 `config.json`**，只替换可执行文件。
- 数据库结构在启动时自动升级。升级后已有学生需重新登录，管理员登录不受影响。历史代码不在启动时批量清理；同一题再次成功提交时替换该题旧代码。

导入考试包会使上一场考试的学生登录失效。新题面先保存到独立目录，再替换考试数据；写文件或数据库事务失败时，保留原有考试与提交。“重新比赛”会解除所有考生的已交卷状态，并按管理员选择保留或清空先前提交。

## 考试包与提交包

`OJ 比赛详情导出考试包 → 监考端考场总览「导入考试包」预览并导入 → 组织考试 → 工作区「导出提交包」 → OJ 对应比赛预览并导入测评`

考试包名单必须包含 `student_id,name,password`，三列均非空；不再提供默认学生密码。旧包缺密码时请在 OJ 补齐名单后重新导出。提交包只有身份对应和有效代码，不包含密码。两端导入均先预览，选错包会提示正确入口。

## 配置（config.json）

| 字段 | 说明 |
|---|---|
| `data` | 数据目录，默认 `./data` |
| `listen` | 监听地址，默认 `0.0.0.0:10293` |
| `admin_username` / `admin_password` | 首次启动创建的管理员账号；密码留空则自动生成 |
| `session_secret` | 会话签名密钥，至少 32 字节；留空则首次启动自动生成并保存 |
| `statement_password` | 题面加密压缩包密码（开考时公布），默认 `GoJustCPC` |

`session_secret`、`admin_password` 也可分别用环境变量 `JUSTCPC_EXAM_SESSION_SECRET`、`JUSTCPC_EXAM_ADMIN_PASSWORD` 提供；配置文件路径可用 `JUSTCPC_EXAM_CONFIG` 指定。

## 从源码构建

```bash
# 本地运行（首次自动生成配置）
go run ./src

# 打包 Windows / Linux 发行版（压缩包输出到 build/release/）
./script/build-release.sh
```

## 主要接口

- 考生：`/api/login`、`/api/exam`、`/api/problems`、`/api/statement`、`/api/problems/:label/submissions`、`/api/early-submit`、`/api/events`
- 管理：`/api/admin/import`、`/api/admin/export`、`/api/admin/exam/{schedule,restart,:action}`、`/api/admin/contestants`、`/api/admin/rules`、`/api/admin/audit`、`/api/admin/events`

## 构建发行版

`VERSION=1.0.1 ./script/build-release.sh` 构建应用并将发行包输出到 `build/release/`。Linux 包含本项目的安装、更新、卸载脚本；安装过程不需要 Go 或其他语言运行环境。Windows 仅保留程序、config.json 与使用说明。

## 项目目录

- `src/`：应用源码；`script/`：内部开发与构建工具。
- `config/`：配置模板；`docs/`：开发、部署和更新记录。
- `build/bin/`：本地编译程序；`build/release/`：发行包，均不入库。
- `test/`：本地测试，不入库；根目录 `config.json` 和 `data/`：本地配置与用户数据，不入库。
- 根目录 `install.sh`、`update.sh`、`uninstall.sh`：发行版操作入口。
