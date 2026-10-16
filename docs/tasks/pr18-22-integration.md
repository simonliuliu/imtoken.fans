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
