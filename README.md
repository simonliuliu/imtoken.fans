# imToken Fans

面向 imToken 钱包用户的社区平台，由原 imAihunt 改造。四个一级板块：**钱包安全、产品共创、综合交流、活动区**。产品共创下设产品反馈、社区产品、产品公告；社区产品不限于 AI。钱包安全以官方/用户故事与案例为核心，交流首版支持币圈行情等论坛讨论。

当前阶段（2026-10-16）：整合全站品牌、简化板块、登录体验、社区产品与真实产品反馈。正式环境已接入原 Supabase；其他演示内容仍有明确边界。进度与验证见 [本批集成](docs/tasks/all-pr-integration.md)，视觉效果待用户 review。

本地预览：[http://localhost:4000/zh](http://localhost:4000/zh)。VS Code 打开本目录，在终端运行 `npm run dev`，或按 F5 选择「imToken Fans: 启动并预览 (4000)」。首次安装、停止服务和端口占用处理见 [本地启动说明](docs/local-development.md)。已有服务运行时直接查看，不要重复启动。

## 项目管理入口

- [路线图与任务状态](roadmap.md)：P0/P1/P2、里程碑与执行记录。
- [详细产品需求](docs/product-requirements.md)：四板块规则、需求编号、反馈合并/撤销、社区产品、公告及验收。
- [产品定位与执行计划](docs/product-execution-plan.md)：四板块范围、代码复用、模型建议、品牌方向与验收。
- [开发协作规则](AGENTS.md)：当前项目方向、Next.js 与 i18n 约束。
- [品牌参考图](docs/assets/imtoken-fans-logo-reference.png)：用户提供的 imToken Fans Logo。
- [多 agent 工作流与指挥示例](docs/agent-workflow.md)、[模型清单与成本依据](docs/agent-models.md)：角色 Prompt、模型分配、文件归属与升级规则。
- [旧路线图](docs/archive/imaihunt-roadmap-v0.2.md)、[旧定位计划](docs/archive/imaihunt-product-execution-plan-v1.0.md)：只作历史参考。

M1-A2 已交付首页、四板块列表/详情和本地互动，M1-B 补齐品牌说明页、图标和分享图。下一阶段为 M2-A 通用内容模型、迁移与历史关系，必须独立 QA；完整首版须通过四板块真实业务验收。

多 agent 工作流已收敛为主聊天总调度、Claude Opus 5.5 设计、GPT 统一前后端开发；QA 按风险启用。Claude 经已验证的 magpie/Devin 临时 CLI 渠道自动调用；原生 developer/qa 配置在 `.codex/agents/`，设计配置在 `.codex/external-agents/`。通常最多两个工作者并发，普通改动由开发自检。M1-A 已按此分工执行；可说「首页 review 通过，按工作流继续下一批」，或直接指出需要调整的页面与效果。

## 技术栈

- [Next.js 16](https://nextjs.org)（App Router + TypeScript + Tailwind CSS v4）
- [Supabase](https://supabase.com)（Postgres 数据库 / 认证 / 存储）
- 部署：[Vercel](https://vercel.com)

> ⚠️ 这个项目用的是 Next.js 16，和网上很多教程里的 Next.js 13/14 写法不一样（比如 `params` 现在是异步的）。如果之后继续用 AI 帮你改代码，记得提醒它先看 `node_modules/next/dist/docs/` 里的文档。

## 已有代码基础与验证范围

- 已有实现：账号登录、产品/点子提交、审核、双维度投票、模拟投资、评论、资料/徽章、角色权限、通知、签到、券制抽奖、后台与数据看板。
- 当前内容模型仅支持产品/点子；图片上传已实现，视频仅外链。板块模型、通用长文帖子、反馈处理状态、重复反馈合并/撤销、单一支持票、社区产品适配、官方公告、视频文件上传和活动公告需要补齐。
- M1-A 已核验原数据库公共只读连接、工程构建与本地页面。迁移、生产部署及真实账号读写流程尚未重新验证，具体边界见 review 记录。
- 已安装锁定依赖与项目内 Node 22.23.3，并阅读安装版 Next.js 指南。2026-10-15 整理首次 GitHub 提交；代码保存方式见下方。

## GitHub 保存代码（第一次使用）

仓库：[simonliuliu/imtoken.fans](https://github.com/simonliuliu/imtoken.fans)，为公开仓库，任何人可阅读；只有获得授权的协作者可以推送任务分支。电脑上的项目目录仍是 `/Users/simonliu/Desktop/imtoken.fans`。

以后可以直接对 Codex 说：「按团队协作规则完成这个任务并提交 PR」。所有开发先同步主线，再新建自己的任务分支；每次提交前再次同步远端，解决冲突并检查，再推送自己的分支，由仓库所有者决定合并；你说“合并”后，Codex 检查、解决冲突并执行。详细操作见 [团队协作规则](CONTRIBUTING.md)。VS Code 里“保存文件”只保存到电脑；Git 的“提交”记录本地版本；“推送”才会同步到 GitHub；PR 是申请将任务分支合入主线。

`.env.local` 中的真实密钥、`node_modules` 依赖和 `.next` 构建结果已排除，不会上传。GitHub 中只保留空值配置模板 `.env.example`；换电脑时需要单独、安全地配置 `.env.local`，再安装依赖。

推送代码不会自动发布网站。当前仓库用于保存和追踪代码，演示与真实业务的验证边界仍以各阶段 review 为准。

下文为原项目已有实现与环境配置说明。出现的 `imaihunt` 项目名、模拟投资及产品/点子交互属于历史实现；新方向与优先级以上述管理文件为准。

## 已有登录功能

`src/app/[locale]/auth/sign-in/page.tsx` 已实现登录；下列功能仍需在当前环境验证：

- **邮箱 / 密码**：`src/app/[locale]/auth/actions.ts` 里的 `signUpWithPassword` / `signInWithPassword`，直接调用 Supabase Auth。注册后默认需要邮箱验证（Supabase 项目的默认设置），验证链接会跳回 `/auth/callback`。
- **用户名 / 密码**：同一个文件里的 `signUpWithUsername` / `signInWithUsername`，不需要真实邮箱，注册后不用等邮件验证就能直接登录（原理见 `src/lib/username.ts` 的注释）。登录页里"邮箱 / 用户名"是个切换开关。
- **Google 登录**：同一个文件里的 `signInWithGoogle`，走标准的 Supabase OAuth 流程，跳回 `/auth/callback` 换取 session。需要先完成下面「配置 Google 登录」。
- **钱包登录**：`src/lib/wallet-client.ts` + `src/app/api/auth/wallet/`，用的是签名验证（类似 SIWE）。两种连接方式都已经接好：
  - 浏览器插件钱包（MetaMask）/ imToken 内置浏览器：不依赖 Reown，只要浏览器里有钱包就能用
  - 手机扫码连接（WalletConnect，用的是 `@walletconnect/ethereum-provider`）：需要 `NEXT_PUBLIC_REOWN_PROJECT_ID`，没配置的时候这个按钮会自动隐藏，只留插件钱包选项
  
  两种方式都需要在 `.env.local` 配置 `WALLET_AUTH_SECRET`（运行 `openssl rand -base64 32` 生成一个随机值即可，用来给登录验证码防篡改）。
- 会话保活靠 `src/proxy.ts`（Next.js 16 把 middleware 改名叫 proxy 了），每次请求自动刷新过期的 token。
- 新用户注册后要在 `profiles` 表里自动建一行记录，这个逻辑在 `supabase/migrations/0002_auth_profile_sync.sql` 里（一个数据库触发器），**执行完 `0001_init.sql` 之后记得也执行一下这个文件**。

在没有配置 Supabase 项目凭证之前，登录页会显示一条提示，所有登录按钮会被禁用，不会报错崩溃。

## 已有产品/点子社区功能

提交、审核、投票、模拟投资、评论、Profile 和管理后台已有 Supabase 读写实现；本次没有重新验证数据库配置与运行结果。

- **提交产品/点子**：`src/app/actions/submissions.ts` 的 `createSubmission`，有 24 小时提交冷却（防刷），提交后按下面的审核模式走。
- **审核**（`src/lib/moderation/`）：提交和评论各自有一个审核模式，管理员在 `/admin` 里三选一——**不审核**（直接发布）/ **人工审核**（进队列，管理员手动通过/驳回）/ **AI 审核**（调用 Anthropic API 自动判断）。AI 审核的判断标准写在 `src/lib/moderation/prompts/submission.md` 和 `comment.md` 里，改这两个文件就能调整审核口径，不用碰代码。没配置 `AI_MODERATION_API_KEY` 时，后台的"AI 审核"选项会自动置灰；配置了之后不用改代码、不用重新部署，直接就能用。AI 判断失败（超时/没配 Key/调用出错）会自动退回人工队列，不会卡住也不会误发布。
- **投票 / 模拟投资 / 评论**：`src/app/actions/votes.ts` / `investments.ts` / `comments.ts`。投票分"愿意付费"和"很有创意"两个维度，评论支持一层回复，评论也会走上面的审核流程。
- **Profile 徽章**：`src/lib/badges.ts`，根据真实的提交/评论/投资记录自动计算（genesis_member 前 50 名 / 点子贡献者 / 活跃评论者 / 模拟投资人），不是写死的示例。
- **管理后台**（`/admin`）：已有审核、用户、内容与活动管理。管理员与成员可进入，成员按细粒度权限访问相应页面/操作；新项目首次管理员仍需在受控环境中初始化 `profiles.role = 'admin'`。

## 等级体系与活动中心

- **用户等级**（`src/lib/level.ts`）：Lv0-Lv10，累计经验值门槛
  `100 / 600 / 1600 / 3600 / 7600 / 14600 / 24600 / 44600 / 74600 / 124600`。
  ⚠️ 这份数字同时存在于 `src/lib/level.ts` 的 `LEVEL_THRESHOLDS` 和迁移 0016 里的
  `level_for_xp()` 函数（一个画进度条、一个算等级并写回 `profiles.level`），**改一边必须改另一边**。
  等级徽章会出现在评论区、悬停名片、提交详情页、后台用户列表等所有显示用户名的地方；
  自己的个人中心能看到进度条和"还差多少升级"，别人的主页只看到等级和经验总量；升级会发站内通知。
- **经验值怎么加减**（`src/lib/xp.ts` + 迁移 0016 的 `award_xp` / `award_xp_by_rule` / `revoke_xp`）：
  应用层永远不直接 `UPDATE profiles.xp`——必须走这几个 SECURITY DEFINER 函数，
  因为经验值要原子自增、等级要在同一个事务里算好写回。每一笔加减都在 `xp_events` 留痕，
  靠 `(user_id, action, ref_id)` 唯一索引做幂等（同一条评论/提交不管触发几次都只计一次分），
  内容被删除或审核驳回时对应的经验会被收回，从回收站恢复时再补回。
- **后台可配**（`/admin/campaigns`，需要 `manage_campaigns` 权限）：签到周期天数与每天的经验奖励、
  社区各类行为的经验值和**每日计分上限**（防刷分的关键）、抽奖次数与消耗、
  九宫格 8 个奖位的奖品/权重/获奖人数上限。改完即时生效，不用重新部署。
  用户管理页里还能给单个用户手动补经验或直接设等级（冷启动和事后补偿用）。
- **活动中心**（`/activities`）：只放"能动手玩的东西"——每日签到（连续 N 天一个周期，
  第 N 天大奖，断签重来，只发经验值）+ 九宫格抽奖（选中光效沿外圈游走后减速停在中奖格）。
  经验条在个人主页，规则说明在 FAQ，活动页不重复这些内容。
  游客也能看奖品和概率，参与要登录。「一天」统一按**北京时间（UTC+8）**算，
  签到、每日计分上限、抽奖每日次数都是这个口径。
- **抽奖券**（`profiles.lottery_tickets` + `lottery_ticket_events` 流水）：抽奖是**纯券制**，
  手里没券抽奖按钮直接点不动，券数量一直显示在抽奖按钮下面。券只有两个来源：
  ① 后台「用户管理」里人工发放；② 九宫格里的「抽奖券」奖品（相当于再来一次）。
  ⚠️ 第 ② 条要先有券才够得着，所以**新站上线时必须先在用户管理页发一批券**，否则谁都抽不了
  （后台抽奖设置面板里有这条告警）。
- **抽奖活动时间**：`lottery_settings.starts_at / ends_at`，后台用日期时间选择器配，
  留空表示该侧不限制。未开始 / 已结束时按钮置灰并显示对应文案——但真正的判定在
  `perform_lottery_draw()` 里做，客户端改时钟或直接调 Server Action 都绕不过去。
- **抽奖的两个硬约束**：① 必须有一个启用中且不限量的「兜底奖位」（谢谢参与），
  否则限量奖品全抽完后无奖可发，抽奖会直接不可用（后台有红色告警提示）；
  ② 库存靠 `update ... where awarded_count < stock` 的条件更新扣减，并发下不会超发。
- **站内通知**：凡是"发生在用户身上、但用户当时不在现场"的事都会发通知——
  被 @提及、评论被回复、升级、抽奖券到账或被收回、拿到徽章、管理员手动调整经验。
  后四种没有"触发人"，数值放在 `notifications.detail` 里，由通知铃铛按类型各自渲染
  （新增类型只要在 `notification-bell.tsx` 的 `systemNotification()` 里补一条）。
  写入口统一在 `src/lib/notify.ts`，一律走 service_role——`notifications` 表没有开放给
  普通用户的 insert 策略，防的是伪造通知。
- **FAQ**（`/faq`，页脚入口）：经验值获取途径、等级一览、签到与抽奖规则、徽章说明、
  提交与审核。里面所有数值都从数据库配置实时读，后台一改这一页跟着变——
  不把 "+20 经验" 这种数字写死在文案里，否则运营调完规则说明页就开始骗人。
  个人主页的经验条上有「查看规则」直接跳到这里。

## 本地怎么跑起来看效果

```bash
npm ci
npm run dev
```

然后打开 http://localhost:4000。

本地已接入 Supabase 时，可运行 `npm run setup:dev-auth`，再打开 [一键开发登录](http://localhost:4000/zh/dev/login)，选择普通用户 A、B 或管理员。该入口只在显式开启的本机开发模式下可用；详细开关与测试说明见 [本地开发指南](docs/local-development.md)。

## 配置 Supabase（接入真实数据库时需要）

1. 打开 https://supabase.com ，注册/登录账号
2. 点 **New Project**，随便起个名字（比如 `imaihunt`），选一个离你近的区域（比如 Singapore），设置一个数据库密码（记下来，后面可能用得到）
3. 项目建好后，进入 **Project Settings -> API**，你会看到：
   - **Project URL** → 填到 `.env.local` 的 `NEXT_PUBLIC_SUPABASE_URL`
   - **anon public** key → 填到 `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role** key → 填到 `SUPABASE_SERVICE_ROLE_KEY`（这个权限很高，不要泄露给任何人，也不要出现在前端代码里）
4. 进入左侧 **SQL Editor**，依次新建查询，按顺序把 `supabase/migrations/` 下的文件粘贴进去执行：
   - `0001_init.sql` —— 建好所有表和 RLS 策略
   - `0002_auth_profile_sync.sql` —— 新用户注册自动建 profiles 记录
   - `0003_moderation_and_cards.sql` —— 提交/点子列表用的聚合视图、审核模式配置表
   - `0004_rls_hardening.sql` —— 补两个权限漏洞（普通用户不该能自己设成管理员/绕过审核）
   - `0005_admin_logs_fk_fix.sql` —— 修一个外键问题（不然审核过内容的管理员账号会删不掉）
   - `0006` 之后的文件同样按文件名顺序全部执行一遍，其中：
     - `0016_levels_and_activities.sql` —— 用户等级（经验值）体系 + 活动中心（每日签到、
       九宫格抽奖）。**这个文件必须执行**，否则 `profiles` 上没有 `xp` / `level` 列，
       所有依赖登录态的功能（发帖、评论、后台）都会失效
     - `0017_lottery_tickets.sql` —— 抽奖改成纯券制（抽奖券）+ 抽奖活动时间段。
       **也必须执行**，否则抽奖会一直显示"暂未开放"、后台用户列表会查不出数据
     - `0018_more_notifications.sql` —— 补三种站内通知类型（抽奖券 / 徽章 / 管理员调整经验）。
       不执行的话这三类通知写不进去（会在服务端日志里报错），但不影响其它功能
     - `0019_analytics.sql` —— 访问埋点表 + 后台「数据看板」的访问量聚合函数。
       不执行的话看板会显示提示、访问量全是 0，埋点写入会在服务端日志里报错，不影响其它功能
     - `0020_analytics_more.sql` —— 看板第二批指标：注册转化漏斗、新用户回访、等级分布、
       审核效率、互动量、签到 / 抽奖 / 经验值。和 0019 一样是纯新增，不执行只影响看板
5. 想要管理后台能进得去，还需要手动把某个用户设成管理员：**Table Editor -> profiles**，找到对应的行，把 `role` 改成 `admin`

## 配置 Google 登录

1. 打开 https://console.cloud.google.com ，新建一个项目（或用已有的）
2. 左侧菜单 **APIs & Services -> Credentials -> Create Credentials -> OAuth client ID**
3. Application type 选 **Web application**
4. Authorized redirect URIs 填 Supabase 提供的回调地址（在 Supabase Dashboard -> Authentication -> Providers -> Google 里能看到）
5. 创建后拿到 **Client ID** 和 **Client Secret**，填回 Supabase 的 Google Provider 设置里并启用

## 配置 Web3 钱包登录（Reown / WalletConnect）

1. 打开 https://cloud.reown.com （原 WalletConnect Cloud）注册账号
2. 新建一个 Project，拿到 **Project ID**
3. 填到 `.env.local` 的 `NEXT_PUBLIC_REOWN_PROJECT_ID`

## 项目结构

```
src/
  app/
    [locale]/             双语前台：首页、产品/点子、活动、资料、登录与说明页
    admin/                中文后台：内容、用户、举报、回收站、活动、看板
    actions/              提交、媒体、评论、投票、通知与活动 Server Actions
    api/                  钱包认证与埋点
    auth/callback/        OAuth 回调
  components/             前台/后台界面组件
  i18n/                   双语路由、请求配置与导航封装
  lib/
    supabase/             browser/server/admin 客户端
    moderation/           审核流水线、AI 审核与 Prompt
    submissions.ts        submission_cards 查询
    media.ts              上传限制与公开图片 URL
    activities.ts         签到与抽奖读取
    types.ts              内容、权限、通知等类型
messages/                 zh.json / en.json，键和占位符必须对应
supabase/migrations/      0001–0022，共 22 个迁移文件
scripts/check-i18n.mjs     双语键、占位符与代码引用检查
docs/                     当前执行计划、环境历史评估、品牌参考及旧计划归档
roadmap.md                当前任务优先级与里程碑
```

## 部署到 Vercel

本项目已在 `simonliulius-projects` 下创建 `imtoken-fans` 并连接本仓库。任务分支推送后查看 PR 的 Vercel 预览状态；合入 `main` 后更新主站。正式环境已配置登录与数据库；分支预览不复制正式数据库凭证。最新反馈迁移及本批部署状态见 [本批集成](docs/tasks/all-pr-integration.md)。配置、验证结果与限制见 [自动预览任务记录](docs/tasks/vercel-auto-preview.md)。

以下为后续启用真实业务时的通用配置步骤；不要把本地密钥直接写进公开仓库，也不要未经确认将生产高权限密钥用于外部 PR 预览。

1. 代码推送到 GitHub 后，登录 https://vercel.com ，点 **Add New -> Project**，选择这个仓库
2. 在 **Environment Variables** 里把 `.env.example` 里的变量都填上真实值
3. 点 **Deploy**，几分钟后就会有一个 `xxx.vercel.app` 的正式网址
