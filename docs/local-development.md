# 本地启动与预览

本项目固定使用 `http://localhost:4000`（2026-10-16 用户指定），开发和生产预览都只监听本机 `127.0.0.1:4000`。`npm run dev`、`npm run start`、VS Code F5 与 `.claude/launch.json` 使用同一端口；端口占用时启动失败，先处理占用，不自动切换端口。

## 第一次启动

VS Code 打开项目根目录，先在集成终端执行：

```sh
npm ci
```

项目精确安装了本地 Node.js 22.23.3（`node` 开发依赖），无需修改电脑全局 Node。即使默认终端是 Node 20，安装完成后 `npm run` 的 PATH 会优先使用项目的 Node 22。可执行以下命令核对：

```sh
npm exec -- node --version
```

预期为 `v22.23.3`。VS Code F5 也直接使用 `${workspaceFolder}/node_modules/node/bin/node`。`.nvmrc` 提供同版本提示；没有 nvm 也可直接使用本地依赖。安装阶段可能因为全局 Node 20 而出现依赖 engine 警告，本地 Node 安装完成后再运行检查。

## 最简单的预览方式

在 VS Code「运行和调试」中选择 **imToken Fans: 启动并预览 (4000)**，按 F5。启动后自动用默认浏览器打开 `http://localhost:4000`；停止调试可结束本次启动的开发服务。若浏览器未自动打开，直接访问上述地址。

也可使用 VS Code 集成终端：

```sh
npm run dev
```

看到 Local 地址后访问 `http://localhost:4000`，按 Ctrl+C 停止。只选择一种启动方式，避免同时启动两个服务。「调试已运行页面」仅附加到已经启动的网页，不启动服务。

生产模式需要先成功执行 `npm run build`，再执行 `npm run start`。生产服务也固定在本机 4000。生产环境如果只安装 `--omit=dev`，需由部署环境另外提供受支持的 Node 22.13+，不能依赖开发依赖中的 Node。

## 4000 已被占用

macOS 可先查看监听进程：

```sh
lsof -nP -iTCP:4000 -sTCP:LISTEN
```

确认进程属于自己之前开的本项目后，回到对应终端 Ctrl+C 或停止对应 VS Code 调试会话。未知进程先确认用途，不自动杀进程。若是本项目已经运行，直接打开现有 4000 页面，无需再次启动。

## 本地 Supabase（真实数据库）

项目提供独立本地 Supabase，配置在 `supabase/config.toml`，CLI 由根目录 `mise.toml` 锁定为 **2.121.0**。Docker / OrbStack 必须先运行。它包含 Postgres、Auth、REST、Storage、Studio 和 Mailpit；未使用的 Realtime、Edge Functions、日志收集和连接池不启动。

首次准备工具和只绑定本机的 Docker 网络：

```sh
mise install

docker network create --driver bridge \
  --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 \
  tokenfans-local
```

网络只需创建一次；已存在时用 `docker network inspect tokenfans-local` 确认其选项为 `127.0.0.1`，不要删除正在使用的网络。日常启动：

```sh
mise exec -- supabase start --network-id tokenfans-local
```

首次启动会下载镜像，并从空库按顺序执行现有 `0001`–`0031` 迁移。迁移 0030 内有可识别的示例帖子，不创建虚构用户；本地没有额外种子 SQL。启动与停止不连接共享 Supabase，也不需要登录或 `supabase link`。

| 服务 | 本机地址 |
| --- | --- |
| Supabase API（Auth / REST / Storage） | `http://127.0.0.1:54321` |
| Studio（表、SQL、Auth 用户与 Storage） | `http://127.0.0.1:54323` |
| Mailpit（本地测试邮件收件箱） | `http://127.0.0.1:54324` |
| Postgres | `127.0.0.1:54322`，数据库 `postgres` |

应用连接配置只保存在被 Git 忽略的 `.env.local`。本批 setup 会自动写入本地 API URL、anon key 和 service-role key，并保留钱包密钥。重新创建本地服务后，可在自己的终端运行 `mise exec -- supabase status -o env` 获取本地连接值；将 `API_URL`、`ANON_KEY`、`SERVICE_ROLE_KEY` 分别对应到 `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`。不要把包含密钥的输出发到聊天、截图或提交到仓库。

本站地址保持 `NEXT_PUBLIC_SITE_URL=http://localhost:4000`。外部 Google OAuth / WalletConnect 仍需各自的开发配置；本地邮箱密码账号可直接注册，邮箱确认按本地默认关闭。密码重置等邮件只进入 Mailpit，不向外部邮箱发送。投稿、评论是否待审核以数据库 `moderation_settings` 为准；本地空库按迁移默认值初始化，不复制共享库的运营设置。

接入后运行真实接口验收：

```sh
npm run test:db:local
```

脚本只接受回环地址 `:54321`，创建两名标记明确的临时测试用户，验证密码登录、自动 profile、真实发帖及重试、待审核隔离、发布后的跨账号读取、评论、点赞、RLS 与文件上传目录权限；结束时精确清理本次用户、帖子、文件及通知事件。它不启动网页，因此不占用 4000；外部 OAuth 和浏览器业务全流程需另行验证。

保留数据并停止本地服务：

```sh
mise exec -- supabase stop --network-id tokenfans-local
```

再次执行启动命令可继续使用本地数据。`supabase db reset` 会重建数据库、`supabase stop --no-backup` 会丢弃本地状态，均不是日常启动步骤；需要清空时先明确确认数据用途。

API 的 `auto_expose_new_tables = true` 明确保留旧项目迁移所依赖的默认授权；迁移中的 RLS 和显式 REVOKE 仍生效。本批不在迁移后补全表授权，以免放宽现有权限。已安装 CLI 模板与同版本标签内 Go 源码对默认行为的描述存在差异，因此显式配置并以真实 API 权限测试为准；升级 CLI 前须复核显式授权，不能直接去掉版本锁定。

本批未启用 Realtime：首次镜像下载遇到仓库限流和长时间等待，代码检索也确认当前应用没有 `.channel()` / `postgres_changes` 依赖。需要开发实时订阅时，在配置中启用并重新启动、补充相应验收。

当前环境的执行结果与限制见 [本地 Supabase 任务记录](tasks/local-supabase.md)。网页固定使用 4000，保留 bman 的 3000 端口；端口被其他项目占用时先确认用途，不自动结束其他服务。本次真实注册/登录、点赞/评论及刷新持久化验证见 [4000 服务验收](tasks/dev-server-4000.md)。

## 一键开发登录

打开 [本地开发登录](http://localhost:4000/zh/dev/login)，点击「普通用户 A」「普通用户 B」或「开发管理员」即可登录或切换真实账号。管理员进入现有 `/admin`；用户 A/B 便于检查跨账号可见性。正常登录、审核、RLS 和退出仍生效。

首次或重置本地数据库后运行：

```sh
npm run setup:dev-auth
```

命令严格限制本地 Supabase 和 4000 站点，准备三个明确标记的测试账号、保存随机密码并开启本地开关；不会输出密码或写入远程数据库。重复运行会先验证现有凭证，只退出临时验证会话，不会把已登录的浏览器登出。三个开发账号保留供测试，勿把它们当作真实用户运营数据。

入口仅在 `NODE_ENV=development`、`LOCAL_DEV_AUTH_ENABLED=true`、本机 API 和本机站点条件同时满足时可用；生产模式或远程 Supabase 一律关闭。关闭时将 `.env.local` 中 `LOCAL_DEV_AUTH_ENABLED` 改为 `false`。账号密码只在服务端使用，不需要手动输入。

边界检查：`npm run test:dev-auth`。中英文页面和完整验证见 [一键开发登录任务](tasks/local-dev-auth.md)。

## 数据库与首页预览

普通社区发帖、评论、回复、点赞、关注、通知与成长已随后续 PR 接入真实数据库；示例正文仍有明确标记。缺少配置时不能把页面内演示或构建成功当作真实互动验收。最新交付见 [普通社区任务](tasks/real-community-interactions.md)。

共享库沿用原未上线 imAihunt 项目；本机测试使用上面的独立 Supabase，不复制真实用户数据或生产凭证。环境值只放 `.env.local`，服务 URL 固定为本地地址后再运行真实写入测试。`NEXT_PUBLIC_` 配置会在构建时写入前端，切换数据库后应重启开发服务，生产预览则重新构建。

## 本批工程检查

2026-10-15：`npm ci` 完成；已安装并实际执行本地 Node 22.23.3。Next.js 与 eslint-config-next 精确更新为 16.3.8，定向更新 sharp 0.35.5、source-map-js 1.2.2、axios 1.20.0；cdp-sdk 在父依赖允许范围内解析为 1.58.0。`npm audit --omit=dev --json` 报告生产依赖 0 项漏洞；随后仅运行 `npm update brace-expansion js-yaml`，更新 3 个传递包：brace-expansion 1.1.21 / 5.0.12 与 js-yaml 4.3.2，未添加直接依赖、override 或强制升级。最终全量 audit 剩余 5 项 high，均沿 ESLint 配置的 fast-glob → micromatch → braces 3.0.3 链传播（包含 5 个受影响包，不是 5 个独立根漏洞）；这些包用于开发期代码检查，生产依赖 audit 仍为 0。未降级 eslint-config-next，braces 无可用兼容补丁的问题留待上游修复；不将生产结果当作全部依赖无风险。定向更新后 lint 通过。

已阅读当前安装版的本地指南：`node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md`、`node_modules/next/dist/docs/01-app/02-guides/debugging.md`、`node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`。实际启动、浏览器、F5、端口冲突与无数据库分支由本批统一验证分别记录，不能由配置存在推断通过。
