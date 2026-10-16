# 本地 Supabase 开发环境

日期：2026-10-16。分支：`codex/local-supabase`。

## 目标与范围

为 imToken Fans 提供独立、本机可测试的 Supabase，包含 PostgreSQL、Auth、REST、Storage、Studio 和邮件收件箱。项目保留现有 0001–0031 迁移，不连接共享数据库。用户要求保留 bman 的 3000 端口；初始批次仅启动 Supabase，后续用户明确指定 tokenfans 使用 **4000**。当前网页和真实浏览器验收见 [4000 开发服务任务](dev-server-4000.md)。

## 执行与验收

- [x] 通过 mise 安装并锁定 Supabase CLI 2.121.0（实际 `--version` 已核对）。
- [x] 初始化本地配置，核对端口、Auth 回调及容器网络暴露。
- [x] 从空库执行全部现有迁移，记录准确结果。
- [x] 将本地连接信息写入被忽略的 `.env.local`，保留钱包密钥。
- [x] 真实验证 Auth、自动 profile、跨会话读写、RLS 和 Storage。
- [x] 独立 QA 检查本地配置、迁移状态及权限验证证据（独立静态审查；实际运行由主调度执行）。
- [x] 补充日常启动、停止、测试和回退说明，运行必要工程检查。

## 当前检查证据

- 已从最新主线 `3e2171c` 新建任务分支；保留原 `.env.local`。
- 项目专用网络 `tokenfans-local` 的 `com.docker.network.bridge.host_binding_ipv4=127.0.0.1` 已核对；实际 API 54321、数据库 54322、Studio 54323、Mailpit 54324 全部只发布在 127.0.0.1。其余容器端口不发布到宿主。
- 既有迁移依赖旧默认授权，显式设置 `api.auto_expose_new_tables=true`，不添加迁移后的全表授权。已安装 CLI 模板说省略此项默认 true；同版本标签内 Go 源码描述默认收回和兼容项移除，存在实现/来源差异。本批以实际 11 项权限与接口测试为准，不将源码日期当作已安装实现的确定行为；升级前单独复核显式授权。
- `npm run lint`、`npm run check-i18n`（1576 键）通过；测试目标保护已验证拒绝远程地址、其他端口、非根路径和查询参数。
- 首次启动后台日志及退出码仅保存在 `.git/local-supabase-task/`（目录权限 0700），可能包含本地凭证，不提交或输出原始日志。
- 首次镜像下载遇到公共仓库限流；CLI 自动尝试官方备用镜像源。Realtime 独立下载长时间未完成，确认应用无 `.channel()` / `postgres_changes` 依赖后，仅停止本任务的启动/下载进程，并禁用可选 Realtime。其他镜像复用缓存，第二次启动退出码 0；其余现有服务未停止。
- PostgreSQL 17.11；数据库迁移表确认 **31** 行，首 `0001`、末 `0031`。迁移原文与顺序未修改。
- `npm run test:db:local`：**11 项真实接口检查通过**，覆盖 Auth、两账号 profile、发帖幂等、待审核隔离、匿名/身份伪造拒绝、自提权拒绝、反馈原表 REVOKE 与读 RPC、审核后跨账号读取、点赞、评论审核和 Storage 上传/越权。临时账号、帖子及文件清理成功。
- 另行实测公开 `auth.signUp` 创建真实 session / profile，`resetPasswordForEmail` 邮件被 Mailpit 捕获，精确清理该账号和邮件成功。此项不是当前 11 项脚本的一部分。
- 8 个容器运行正常；有健康检查的 7 个容器均 healthy。Studio 与 Mailpit HTTP 200。测试后 `auth.users=0`、示例帖 11、XP 流水 0；审核设置为投稿 human / 评论 none，来自迁移默认值。
- `.env.local` 仅修改三项 Supabase 连接配置，权限 0600，钱包签名密钥逐字保留，未展示凭证。
- 接入本地连接配置后的 `npm run build` 通过（Next.js 16.3.8、类型检查、68 页生成）；末次 `npm run lint` 与 `git diff --check` 通过。构建保留已有的仓库外锁文件提示和两次 `maxWidth: none` 非阻塞告警。
- 精确比较迁移表版本列表与磁盘 31 个文件一致；`auth.users`、Storage 对象、评论和审核队列均无本次临时记录。任务文件扫描未发现生成的三项密钥；`.env.local` 与 CLI 缓存已忽略。
- 独立 QA 初审 OK，发现一项 P2：初版 smoke 漏清无级联外键的通知事件账本。已按本次帖子/评论 ID 精确清理并断言无残留；复跑 11 项真实检查与定向 ESLint 通过，11 条示例事件保留、非示例事件 0。原审查者复核结论 **OK，P2 已解决，无新增缺陷**。独立审查为源码/证据审查，运行态由主调度验证，见 [QA 记录](../reviews/local-supabase.md)。
- 保留数据停止/重启通过：写入唯一测试标记，`supabase stop` 保留备份，再次 start 从备份恢复后精确读回并清理该标记；8 个容器恢复健康状态，本机应用 URL 与两项 API key 与 `.env.local` 仍一致。没有重新执行或重复计入迁移。

## 日常使用与范围

- 启动：`mise exec -- supabase start --network-id tokenfans-local`。
- 保留数据停止：`mise exec -- supabase stop --network-id tokenfans-local`。
- 真实接口检查：`npm run test:db:local`。
- Studio：`http://127.0.0.1:54323`；API：`http://127.0.0.1:54321`；邮件：`http://127.0.0.1:54324`；数据库：`127.0.0.1:54322`。
- 网页已按后续用户指令在 `http://localhost:4000/zh` 启动，登录来源和回调同步为 4000，保留 bman 的 3000。网页注册/登录/点赞/评论与刷新持久化证据见 [4000 验收](dev-server-4000.md)。
- 未启用 Realtime、Edge Functions、CLI 日志收集、连接池；外部 Google / WalletConnect 配置与钱包注入签名未验收。
- 新机器 setup 和凭证映射详见 [本地开发说明](../local-development.md)。

## 参考

- [Supabase CLI 官方启动说明](https://supabase.com/docs/guides/local-development/cli/getting-started)
- [Supabase CLI 配置](https://supabase.com/docs/guides/cli/config)
- [Docker bridge 的默认宿主绑定地址](https://docs.docker.com/engine/network/drivers/bridge/#default-host-binding-address)
- 已安装 CLI 的 `init/start/status --help` 与实际生成配置优先作为本批操作依据。

## 数据与回退

本批只创建项目专属本地 Docker 容器及卷；不运行 `link`、远端 push、生产 SQL 或共享库测试。原有 `.env.local` 的非 Supabase 配置保留。日常停止使用 `supabase stop`，保留本地数据；重置数据库属于显式破坏性操作，不作为默认启动或验证步骤。

## 风险与限制

| 风险 | 可能性 | 缓解 |
| --- | --- | --- |
| 历史迁移不能从空库完整重放 | 本批已排除 | 31 个迁移原样执行，数据库迁移表计数确认 |
| 本地服务暴露给局域网 | 本批已排除 | 网络默认绑定和全部容器实际发布端口均为 127.0.0.1 |
| 测试误接远程库 | 低 | 测试脚本限制 URL 为本机，密钥不输出 |
| 3000 被 bman 占用 | 已确认 | 不启动 tokenfans、不改端口、不终止其他服务 |

核心原则：以真实本地服务和持久化读写证明环境可用，不以 mock 或构建成功代替数据库验收。
