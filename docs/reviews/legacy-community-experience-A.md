# 原站交互继承 A · 评论与独立发布 review

2026-10-16 · 实现及整合检查完成，等待用户 review。未合并本批代码，未主动部署。

## 范围

以旧 imAihunt 为交互参照，调整社区示例/真实反馈评论呈现及独立发布路径，保留主线真实反馈能力。旧真实评论服务端逻辑、等级/XP、活动 RPC 与后台权限保留；成长/后台/活动的新业务接入见后续任务，不在本批宣称完成。

## 浏览与验收路径

本地服务已按用户明确选择切回本批，统一 http://localhost:3000。界面可直接查看，普通发帖与示例评论仅本地预览。

| 路径 | 实际检查 | 结果 |
| --- | --- | --- |
| `/zh/community/discussion/learning-notebook` | 连线、针对子回复的 @ 目标、赞 8→9、评论 6→7、折叠/展开、重载复原；举报明确不可用 | 中文桌面及英文手机通过；示例无真实写入 |
| `/zh/submit` / `/zh/submit/post?section=safety` | 独立页面、普通帖字段、预选钱包安全、填写后预览、单一 main，无弹窗 | 浏览器通过；普通帖不持久化 |
| `/zh/submit/feedback` | Bug/建议动态字段、匿名可见表单、切换字段、字符限制、登录及草稿保护 | 桌面/英文手机通过；真实提交契约经独立 QA，未在真实库试发 |
| `/en/submit/product` / `/en/submit/idea` | 固定投稿类型；匿名跳转登录并保留精确返回路径；旧 type 参数兼容 | 浏览器及源码/VM 复核通过；真实上传/投稿未重测 |
| 中英 1440px / 390px | 唯一主要发帖入口、分类先于排序、表单布局及评论操作换行、无横向溢出 | 浏览器通过；合并遗漏的表单/连线样式已恢复并重拍 |

## 工程与独立 QA

基于最新主线 `de69d6c` 整合后重新检查：`check-i18n` 1518 键、lint、生产构建、6 项既有认证安全回归及 `git diff --check` 通过。旧反馈演示实现及截图不作为最终证据。

独立 QA 复核登录等待、匿名续写、账户/会话隔离、旧草稿兼容、重复提交 UUID、expected_user_id、5000 字限制、异步卸载保护及固定产品类型。产品/点子的真实上传与提交函数相对主线保留，评论 parent_id/分页/隐藏回复/处理权限参数未改。已修复发现的问题，无遗留 P1/P2。

未对真实账号执行发布、附件上传、审核或 XP 写入；未新增迁移，未修改 Actions、SQL、真实成长、活动或后台权限。真实库各角色写入、RLS 与完整产品流程仍依赖后续业务验收。

## 截图

- [中文桌面评论](screenshots/legacy-experience/comments-desktop-zh.png)
- [英文手机评论](screenshots/legacy-experience/comments-mobile-en.png)
- [中文独立普通帖](screenshots/legacy-experience/post-desktop-zh.png)
- [中文反馈表单](screenshots/legacy-experience/feedback-desktop-zh.png)
- [英文手机 Bug](screenshots/legacy-experience/feedback-mobile-en.png)
- [英文手机建议](screenshots/legacy-experience/feedback-suggestion-mobile-en.png)

## 业务边界与下一阶段

- 演示内容、作者与互动不写真实库，不发经验/通知，不进行真实举报或官方处理。完整折叠/排序属于示例线程；真实反馈评论本次只调整头像、操作栏及回复缩进，保留现有分页与处理逻辑。
- 反馈走主线真实 RPC；Bug/建议专用字段序列化到现有 description，不是独立数据库字段。反馈附件/视频上传和普通论坛持久化仍为后续必需交付。
- 原真实产品/点子流程复用；旧评论、资料、XP、历史链接保留。
- 当前为本地预览和 PR 交付。用户 review 本批后，再继续真实帖子目标及成长/后台/活动适配，各重要阶段单独 review。
