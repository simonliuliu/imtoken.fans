# 仅保留产品投稿

日期：2026-10-16 · 分支：`codex/product-submissions-only` · 状态：本地实现、浏览器回归与独立只读 QA 通过；目标库迁移待执行。

## 范围与决策

用户要求删除「提交点子」，只保留「提交产品」。移除投稿类型切换、点子投稿文案与历史列表的投稿号召；旧投稿 URL 只显示产品表单，游客登录后返回产品表单。保留既有产品字段、社区登录、审核、账号隔离草稿与现有视觉样式。

不删除历史点子、评论、投票、积分或旧链接，不把产品反馈的 IDEA/建议当成旧点子投稿移除；不删除本机历史点子草稿。前后端与双语文案由主调度唯一写入。

## 风险与检查

涉及 Server Action 与 RLS：按仓库规则安排独立只读 QA。新增 0026 限制 authenticated 直接插入非产品类型；既有插入策略继续生效，不变更 SELECT/UPDATE/DELETE。回退只需移除本次新增 policy，恢复应用到上一版本，无需恢复数据。

验收：旧 `?type=idea` 不能创建点子，产品字段必填和人工审核保留；旧产品草稿可恢复、历史点子草稿保留；中英桌面/手机无类型切换；服务端与数据库拒绝非产品创建。必需 i18n、lint、build 与针对性测试。

## 实际验证与限制

- `npm run check-i18n`：通过，中英共 1436 键。
- `npm run lint`、`git diff --check`：通过。
- `node --test tests/unit/product-submissions-action.mjs`：4 组通过，执行真实 TS Action、替换外部依赖，不写数据库。覆盖非法类型、产品写入/人工审核、必填字段、登录/黑名单/重复链接。
- 复制本批源代码到独立临时目录并 `npm ci --ignore-scripts` 后，`npm run build`（Next 16.3.8 / Turbopack）通过；既有图标渲染 `maxWidth="none"` 警告仍在，不属于本次变更。隔离构建避免改写端口 3000 旧预览正在使用的 `.next`。
- 独立只读 QA `/root/posting_readonly_qa`：确认 Action、RLS 组合、历史记录/链接、账号隔离草稿均无遗留确认问题；发现的双语 FAQ 残留点子投稿指引已修复并复核。
- 用户明确允许重启后，确认旧服务 PID 63534 属于本工作目录，再停止它进行隔离测试。`npx playwright test tests/product-hunter-auth.spec.ts tests/product-submissions-only.spec.ts`：15 项通过（41.6s）；优化手机截图（窄屏重载、单屏捕获）后受影响 5 项再次通过（10.5s）。覆盖中英桌面/手机、旧点子 URL、历史列表无投稿号召、产品草稿兼容、共享会话与登录回跳。测试使用本地虚构账号/API，无真实库写入。
- 测试结束后恢复正常 `.env.local` 的本地开发服务 `http://localhost:3000`，未改变端口。截图见 [中文桌面](../reviews/screenshots/product-submissions-only/zh-desktop.png)、[中文手机](../reviews/screenshots/product-submissions-only/zh-mobile.png)、[英文桌面](../reviews/screenshots/product-submissions-only/en-desktop.png)、[英文手机](../reviews/screenshots/product-submissions-only/en-mobile.png)。
- 独立 QA 再次复核四张中英桌面/手机截图与窄屏测试调整，确认无类型切换、无明显裁切/横向溢出，本批无新增问题；恢复正常预览后 `/zh/submit?type=product` HTTP 200。
- **0026 尚未应用到目标 Supabase**，没有写入或删除线上数据。迁移应用后仍需实际验证 authenticated REST 的 idea 拒绝/product 合法插入及历史读取；只读策略审查不算数据库执行验收。
- 上一轮提交前两次 fetch 曾遇 GitHub TLS `SSL_ERROR_SYSCALL`，当时保留现场、未绕过同步规则。本轮 fetch 恢复成功，取得的 `origin/main` 仍为 `de69d6c`。

主调度结论：本地页面与行为已验证并恢复正常预览；目标库迁移/实际 REST 验证待执行，交付分支及 PR review，不自动合并主线或宣称线上生效。
