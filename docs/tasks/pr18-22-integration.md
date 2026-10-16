# PR #18–#22 全量整合（2026-10-16）

用户已授权检查并合并所有 PR。基线 main de69d6c；独立分支 codex/merge-pr18-22，不改其他开发现场。

## 冲突决策

保留 #18 共创分类/排序与统一信息流；后续 #20 独立普通/反馈/产品发布页作为最新用户路径，导航按板块进入对应页面，旧 /submit?type 链接兼容跳转。#21 停止新旧 idea 投稿，原 /submit/idea 转到产品表单，保留历史点子和草稿。#19 的匿名登录续写、错误按钮旁聚焦、UUID try/ref锁、相似匹配及作者名过滤同步到实际使用的新版反馈表单，不能只保留在旧 Composer。#22 手机铃铛、关注及通知定位与上述新页面共存。

## 迁移顺序与回退（执行前记录）

三个 PR 的 0026 尚未执行、编号碰撞，统一为 0026_feedback_forum_names、0027_product_submissions_only、0028_following_notifications；只重编号未应用的新文件，旧 0001–0025 不改。测试/操作引用同步更新。

0026 只调整反馈公开名称函数；0027 附加 restrictive product INSERT 与既有作者/pending/黑名单组合；0028 新增关注/通知事件账本、修补系统通知 enum、收紧原表权限与评论直接 INSERT。依赖原 profiles/user_tags/submissions/comments/notifications 和 0025 反馈结构。

先完成代码/独立 QA/分支构建，再执行 [三迁移受控事务](../operations/2026-10-16-pr18-22-transaction.sql)，按原 ID/逐行 JSON 比对历史数据；不生成虚构用户、真实帖子或通知。事务内快照仅用于一致性与错误回滚，不称作独立灾备备份。新表、原消息及事件账本保留。紧接合并发布新客户端：迁移后旧铃铛原表读取被撤权，不能只退回旧应用；异常时优先修复新 RPC/客户端或经审查提供兼容投影。移除 product-only policy 可单独回退新增投稿限制；名称函数可恢复0025定义。不要删除新数据或账本。

## 检查与保留边界

集成 i18n（1540 键）、类型、无警告 lint、Turbopack 生产构建通过；12 项 Composer、6 项认证、4 组产品 Action、21 项名称与19项通知隔离测试通过。独立联合迁移/0024兼容10项通过。新版真实反馈表单独立 14 项处理器/账号切换测试通过；受控三迁移事务也在隔离 PostgreSQL 演练通过（6 表逐行 JSON、ACL、enum COMMIT 后可用和无历史通知回灌）。目标迁移前只读基线：submissions41、profiles28、votes502、comments86、notifications9、feedback_posts2、feedback_comments0；新迁移尚未应用。普通论坛仍演示，不把新发布页当作真实论坛写入；视频/附件、反馈状态/合并专用通知及多连接并发另验。既有真实反馈/产品审核、媒体授权、账号隔离、历史互动和 XP 不可退化。真实 JWT/浏览器多账号成功流程需与隔离测试区分。

## 实际合并与正式激活结果

PR #23 已合并，main `bad9fd4ccb63ac9d30896bdf02d9e6233cf606ba`。GitHub 逐一确认 #18/#19/#20/#21/#22/#23 均 MERGED，未解决讨论为0。Vercel production `dpl_GVWGCxJVcadXGtyo4xQPXx9ce4xk` READY，代码检查成功。

0026/0027/0028 已在原 Supabase 通过受控事务执行并 COMMIT，旧6表逐行JSON与ACL断言通过；原41投稿/86评论/9通知/2真实反馈保留。迁移时28个profile原样保留，之后只读统计29个，属于后续新增，未回写覆盖。历史票502不变、反馈评论0。PostgREST 公共follow_read=200，匿名notification_read和user_follows/notifications/notification_events原表访问=401；不回退到不安全原表。

真实浏览器现有登录会话读取通知中心成功（真实JWT/空通知，无错误），只读检查未点击已读/清空/关注或发表真实内容。新版反馈表单可打开；旧 /submit/idea 及 ?type=idea 均转到产品页。中英首页、共创、独立发布页、通知及三个图片资源均HTTP200。

角色写入/收发的回滚测试脚本已提供，但本轮未在目标库执行；此边界与隔离PGlite测试、真实JWT只读验证区分。真实多账号关注收发/发布、并发及完整业务验收仍待后续。正式页面复核和最终发布记录见本次收尾PR。
