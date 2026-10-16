<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Git 团队协作（2026-10-15）

- 开工及提交前必须阅读并执行根目录 `CONTRIBUTING.md`，人和 AI 使用同一规则。
- 开工先检查工作区，获取远端更新，将本地 `main` 以 `--ff-only` 同步至 `origin/main`，然后从最新主线新建任务分支；禁止直接在 `main` 开发、提交或推送。
- 一人一任务一分支；Codex 用 `codex/<任务名>`，团队成员用 `<类型>/<姓名>-<任务名>`。并行任务使用独立 clone 或 worktree，不能在同一个工作目录同时切换分支。
- 每次提交前先 `git fetch origin --prune`，将最新 `origin/main` 合并进自己的任务分支；有同名远端任务分支时也先合并它。存在冲突则先解决并检查，不能用强推或覆盖他人文件规避。
- 仅暂存本任务明确的文件；检查差异和凭证，按变更范围完成验证。提交后只推送任务分支，创建 PR 并记录检查和限制；合并由仓库所有者 simonliuliu 决定；用户说“合并”即授权 AI 检查、解决冲突并执行，无需其他维护者批准或重复确认。功能阶段的用户 review 仍单独有效。
- 禁止自动执行 `reset --hard`、`clean -fd`、强制推送或丢弃他人的改动；工作区存在其他任务时先保护现场。本地有未完成工作时不得直接 `pull`、切主线或盲目 `stash`。
- 仓库公开不等于可直接写入；邀请协作者由仓库所有者单独授权，未授权成员走 fork + PR。不得上传 `.env.local`、密钥、真实用户敏感数据或包含凭证的日志。

# 当前项目方向与任务管理（2026-10-14）

本项目由原 imAihunt 改造为 **imToken Fans**，服务 imToken 钱包用户。四个一级板块：
钱包安全、产品共创（产品反馈、社区产品、产品公告）、综合交流、活动区。
钱包安全以官方/用户安全故事与案例为核心；社区产品不限于 AI，旧「独立 AI 社区」定位已被替代。
2026-10-15 需求更新：人工归类/合并与撤销属于反馈首版；综合交流先做论坛，PnL/代币 agent 可独立演示，真实交易等另立项。

- 当前任务与进度读 `roadmap.md`，详细需求与验收读 `docs/product-requirements.md`，定位、代码盘点与技术边界读 `docs/product-execution-plan.md`。
  `docs/archive/` 仅作历史参考；旧完成记录不等于本次改造已完成。
- 品牌以 `docs/assets/imtoken-fans-logo-reference.png` 为参考：玫红、深蓝、白底，强调内容可读性。
- 每批实现同步更新路线图的交付、检查结果与限制；未经当前环境验证，不把已有代码标成线上已验收。
- 复用现有账号、评论、审核、通知与签到抽奖；迁移保留历史内容、互动、积分和链接。
  新增 SQL 迁移，不重写已有迁移。板块、内容类型、审核状态、反馈处理状态分开建模。
- 视频文件上传是产品反馈首版必需项，外链不能替代。不要沿用 AI 专属审核规则、
  24 小时统一发帖冷却或愿付费投票来承载新社区而不调整。
- 反馈状态、日志与公告发布都要校验业务权限；认证标签不等于权限。
  不预填官方回应承诺，不收集助记词、私钥或密码；上传提示遮挡敏感信息。
- 模拟投资退出主路径，真实投资/NFT 计划暂停。用户未要求时不扩展这些旧功能。

# 多 agent 调度与模型（2026-10-15，v2）

按 `docs/agent-workflow.md` 执行：**主聊天总调度 + Claude 设计 + GPT 统一前后端开发**，
QA 按风险启用。原九角色仅在 `docs/archive/agents-v1/` 留存，不再默认调度。

- 主聊天默认 GPT-6.1 Sol / medium，负责需求、Brief、任务卡、整合与路线图。
- 设计 Prompt/模型在 `.codex/external-agents/designer.toml`：Claude Opus 5.5 / low。
  由主调度使用 `scripts/run-claude-design.py` 经已有 magpie/Devin 调用；已实测成功。
  原生 spawn 不接受 Claude；不要把 designer 注册为继承 OpenAI provider 的原生角色。
  该渠道是模型设计工作进程，不是 Claude Design 工作台。
- 原生 `.codex/agents/developer.toml` 负责前后端；默认 Sol/medium，小任务可显式覆盖
  为 Luna，复杂/高风险实现可用 Sol/high。不再常驻拆分文案、探索、前端、后端等角色。
- `.codex/agents/qa.toml` 为 Sol/high，合并独立功能验证与安全审查。普通文案、颜色、
  间距、静态布局由开发自检，不自动调用 QA；身份/会话/钱包签名、权限/RLS/API 授权、
  媒体访问/上传、敏感信息、迁移/历史数据、事务并发/抽奖库存及重要跨模块流程必须独立 QA。
- 当前通用 spawn 无命名角色参数时，读取角色指令后显式传模型、强度和任务卡；不同模型
  用独立上下文（当前接口 `fork_turns="none"`），补齐工作目录、约束和文件归属。
- 通常最多两个工作者并发，临时 Claude 进程也计入预算；子 agent 不再派生 agent。
  文案 JSON、全局样式、公共类型、锁文件、迁移一次只有一个写入者。
- GPT 先整理短 Brief；Claude 只做代表页面与设计规范，最多两个初始方向、集中一轮修订。
  常规实现和细节微调交 GPT；不反复向 Claude 发送全库、日志或聊天历史。
- Claude 调用一次运行一次请求，关闭可关闭的多余上下文，限制 Brief/参考图规模，记录实际
  用量；失败不自动切渠道/模型。CLI 固定开销和网关内部路由/账单不能由本地配置保证。
- 配置安装/咨询不自动启动工程；用户已于 2026-10-15 明确开始 M1-A。
  当前任务与 review 状态见 `docs/tasks/M1-brand-home.md`。不得新建/消息额外用户聊天或修改个人全局配置。
- 每次交付更新任务卡、风险检查结果和路线图；模型可见、接口接受、实测执行与功能验收
  分开记录，不用模型自述确认内部型号。实际渠道与检查证据见 `docs/agent-models.md`。

# 本次开发与 review 约定（2026-10-15）

- 页面设计与实现必读 `docs/design/design-rules.md`：减少重复入口，论坛发帖只保留导航入口，分类先于分类内排序。Claude 标准调用脚本自动附入该规则；手动调用也必须提供正文。

- 用户已授权按计划开发。每个重要样式/新增功能阶段完成可查看结果、必要验证与 review 说明后，
  交用户 review，再进入下一重要阶段；不要只给代码或一段抽象计划。小修正可在同一批内完成。
- 当前执行 M1-A2：根据用户review重做社区首页，交付四板块列表/帖子详情与明确标记的虚拟内容，
  任务见 `docs/tasks/M1-A2-community-preview.md`。本轮产品需求整理见 `docs/tasks/product-scope-alignment.md`，仅完成文档；演示命名/分类尚未按新 PRD 调整。完成结构复核后等待review，再进入真实业务阶段。
- 用户已明确允许虚拟数据作本批展示。演示内容/作者/计数/成长须可识别为示例，独立于原库；
  演示评论、点赞、投票与发帖仅本地状态，不调用真实业务Actions，不发XP，不冒充官方回应或活动承诺。
- 数据库继续使用原未上线 imAihunt 的 Supabase。用户授权按需增删表，主调度根据真实依赖决策，
  先记录当前结构、引用与回退方案；不因旧“分环境评估”要求另建库或重复索取同一权限。
  当前尚无已上线生产环境，未来发布前再落实环境隔离。无必要不删除原表/数据。
- 本地开发/启动统一 `http://localhost:3000`，显式指定端口，占用则提示处理，不自动转 3001、
  不自动终止未知进程。VS Code 与终端使用同一约定，提供小白操作说明。
- 原工程 `.env.local` 可复用至当前工程（已复制并固定本站 URL 为 localhost:3000），凭证不输出、不提交。

# 文案与 i18n（改任何面向用户的文字都要看这一节）

前台（`src/app/[locale]/**` 和它用到的组件）是**中英双语**；管理后台（`/admin`）是**纯中文**，
不挂在 `[locale]` 段下（见 `src/proxy.ts`）。

## 铁律

1. **前台不允许出现硬编码的中文或英文界面文案。** 所有面向用户的字都从
   `messages/zh.json` + `messages/en.json` 取，两份文件的键必须一一对应。
2. **改文案就是改这两个 JSON。** 只改中文不改英文 = 英文界面上会出现中文或直接报错。
   加键、删键、改占位符，两边一起动。
3. 提交前跑 `npm run check-i18n`。它会检查：两份文案键集合一致、同一个键的 ICU 占位符
   （`{name}`）和富文本标签（`<link>`）一致、代码里 `t("x")` 用到的键都存在。
4. **不要用 `toLocaleString("zh-CN")` 这类写死语言的格式化。** 日期/数字用 next-intl 的
   `useFormatter()` / `getFormatter()`。唯一的例外是必须"服务端和浏览器逐字节一致"的
   场景（评论时间固定按 Asia/Shanghai 渲染、点子卡片的相对时间），那些地方自己拆时间
   部件再套 messages 里的模板，并且已经在代码里写了原因。

## 怎么取文案

| 场景 | 用法 |
| --- | --- |
| 客户端组件 | `const t = useTranslations("submit")` |
| 同步的服务端组件 | `useTranslations` / `useLocale` 同样可用 |
| `async` 服务端组件 | `await getTranslations("submit")` / `await getLocale()` |
| Server Action | `await getTranslations("errors")`（语言从中间件写的请求头拿，能正常工作） |
| `/api/*` 路由 | 中间件不覆盖这里，语言要由调用方在 body 里带 `locale`，再 `getTranslations({ locale, namespace })` |
| 普通 `.ts` 模块（非组件） | 拿不到 hook：由调用方把文案传进去（例：`src/lib/wallet-client.ts` 的 `WalletMessages`） |

## 例外：这些文案不在 messages 里，是故意的

- `src/lib/tag-taxonomy.ts`、`src/lib/expertise.ts`：数据本身就带 `zh` / `en` 字段，
  按 `locale` 取（`getTagLabel(id, locale)`）。
- `src/lib/level.ts`、`src/lib/types.ts` 里的等级称号 / 徽章 / 角色 / 用户标签 / 举报理由 /
  经验规则：**后台也要用这些标签**，而后台拿不到 next-intl 的 Provider，所以中英两份都放在
  数据旁边。前台走 `levelTierName(lv, locale)`、`badgeInfo(key, locale)`、
  `roleLabel(role, locale)`、`userTagLabel(tag, locale)`、`commentReportReasonLabel(r, locale)`、
  `xpActionInfo(action, locale)`、`xpActionLabel(action, locale)`；后台直接读 `.name` / `.label`。
  改这些标签时中英要一起改。
- `src/lib/wallet.ts` 的签名挑战文案：用户签的那段字必须和校验时重新拼出的完全一致，
  所以语言随 nonce 存进 cookie，文案内联在函数里，不走 messages。
- 数据库函数返回的失败原因（`perform_checkin` / `perform_lottery_draw`）：SQL 里是中文，
  在 `src/app/actions/activities.ts` 用 `DB_MESSAGE_KEY` 映射到 `activityErrors.*` 再翻译。
  SQL 加新的失败分支时，这张映射表和两份 messages 都要跟着补。
- 运营在后台填的内容（抽奖奖品名、通知里的提交标题等）：数据库里存什么就显示什么，
  不做翻译。

## 后台（`/admin`）

保持中文，不要给它加语言切换。它复用了少量前台组件（`LevelBadge` 等），那些组件会调
`useLocale()`，所以 `src/app/admin/layout.tsx` 里把语言钉成了 `zh` 并补了
`NextIntlClientProvider` —— 别把这两行删掉。
