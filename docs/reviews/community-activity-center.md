# 社区活动中心 review

2026-10-17 · `codex/community-activity-center` · 已整合主线 `9cd7be7`。本地实现完成，等待用户 review；未合并、未在共享数据库执行 0032、未发布真实活动。

## 可 review 的行为

顶部原「活动」入口原位进入 `/zh/community/activities`，分类为全部活动、新手任务、每周挑战、我的参与、活动交流、签到抽奖。论坛导航、玫红/深蓝/白底、真实账号与原登录页沿用；游客参与保留语言和活动位置，账号切换清除旧个人状态。

管理员在 `/admin/campaigns` 创建草稿，配置时间、主办方、规则和一项任务：签到核验、安全单选小测、贡献审核或指定产品体验评价审核。可选既有 XP/券/徽章奖励与总获奖人数；发布后规则冻结，可说明原因取消。参与不预留奖励名额，人工任务先审核，评价高低不影响资格。结束后仍可审核此前提交，取消不追回已发奖励。

「我的参与」展示参与/待审核/需修正/完成及到账记录；关注开始/取消通知与审核到账消息复用通知中心。签到抽奖沿用真实配置、时间、库存和券/可选 XP 成本，原 `/activities` 跳到对应分类。最新主线的活动帖子、真实评论/赞同、旧分类及 slug/UUID 链接继续保留，不转成本地假互动。

## Review 发现及修复

| 已确认问题 | 修复与验证 |
| --- | --- |
| 产品评价创建时间可被客户端伪造，活动证据不可信 | 数据库赋新时间并冻结既有创建时间/归属；普通改文/评分和现有 upsert 保持可用；旧评价时间不变，活动前评价不计入 |
| 新外键阻塞评价删除及旧回收站整体清理 | 来源删除时 SET NULL，保留参与与奖励；前后台明确失效状态，失效来源不能审核发奖；实跑原七天清理通过 |
| 操作后客户端状态未重读，抽奖库存/播报过期 | 显式成功回调、可见轮询/焦点刷新、子组件同步；浏览器实际核验库存从 2 变 1、播报出现、外部余额刷新 |

额外整合修复：旧社区帖通知内部链接白名单、旧详情及分类兼容、活动奖励成长来源双语标签、跳转内容锚点、同事务后台审计（不记录小测答案）。独立只读 QA 最终未发现未解决的 P0/P1/P2。

## 实际检查

- i18n 1672 键、全量 ESLint、Webpack 生产构建及类型检查通过。
- 隔离 PostgreSQL：实际 0001–0032 全量迁移；迁移前所有旧 public 表快照一致；17 组活动权限/资格/答题次数/审核/奖励唯一和限额/删除/通知/审计检查通过。注入券流水失败，确认 XP、参与状态、答题次数、奖励名额全部回滚。
- 原通知数据库回归 19 组通过；发布/会话/表单恢复 15 项、通知内部路由 2 组通过。
- 浏览器覆盖 25 项（活动 10、认证 10、仅产品投稿 5），中英 390px、游客回跳、空/错误状态、换账号、答题、签到抽奖刷新、后台草稿发布→用户提交→审核→刷新奖励、旧帖子互动通过。3 条旧认证断言同步主线后定向复跑通过；退出竞态补等待旧资料返回并单独通过。

数据库使用内存 PGlite、模拟平台 auth/storage 和角色；浏览器使用本机独立 HTTP fixture API、虚构账号及明显测试凭证。均不连接真实 Supabase。单连接测试不替代真实多连接并发压测，mock 浏览器通过不等于线上真实多账号验收。

默认 Turbopack 构建在本机停在编译阶段，Webpack 构建通过；旧 dev 持久缓存损坏已通过可恢复移走生成缓存解决，默认 dev 可正常运行。保留既有图标 `maxWidth="none"` 提示。

## 界面截图

以下均为明确标记的本地虚构 fixture，不是已发布活动或真实奖励承诺。

- [中文手机列表](screenshots/activity-center/zh-mobile-local-fixture.png) · [英文手机列表](screenshots/activity-center/en-mobile-local-fixture.png)
- [桌面详情](screenshots/activity-center/en-detail-desktop-local-fixture.png) · [手机详情](screenshots/activity-center/en-detail-mobile-local-fixture.png)
- [签到抽奖](screenshots/activity-center/checkin-lottery-local-fixture.png) · [后台审核与流水](screenshots/activity-center/admin-local-fixture.png)
- [旧活动帖详情](screenshots/activity-center/migrated-post-local-fixture.png)

## 激活与回退

新增且仅新增 `0032_community_activity_center.sql`，保留原 0001–0031。上线前需确认前置迁移完成，再执行 0032、部署相应代码，使用已有 `manage_campaigns` 权限创建并 review 真实活动。新活动初始为空，不自动发布运营内容。

回退保留奖励/参与/回执/审计及评价时间保护，先取消活动并停发，界面停用时保留旧链接和已发通知兼容；不删除历史流水或重置旧余额。详细环境约束与前向回退原则见 [任务卡](../tasks/community-activity-center.md)。
