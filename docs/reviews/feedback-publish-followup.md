# IDEA 登录引导、相似建议和作者名称：独立 QA

日期：2026-10-16。分支：`codex/jack-feedback-publish-error`，PR #19 追加修复。

## 结论

本轮独立检查未发现阻断提交的权限、会话隔离或名称投影问题。匿名发布改为明确登录续写；搜索只有当前标题对应的实际匹配才展示相似建议；作者投影排除 Ethereum `0x` 地址占位名及邮箱，回退有效论坛用户名。未修改应用、迁移或开发者的测试脚本；唯一仓库交付是本文。

`0026_feedback_forum_names.sql` **尚未在目标 Supabase 执行**。迁移应用前，前端可以隐藏旧 RPC 返回的地址并显示「社区用户」，但无法凭旧 RPC 的单个 `author_name` 字段恢复被遮住的论坛用户名；应用迁移后才可完成该用户名回退。此结论不代表线上业务验收。

## 实际检查

全部测试仅执行真实源码的模拟组件处理器、模拟 Server Action 或临时 PGlite；不连接真实数据库、不创建账号、不发布测试内容。

| 范围 | 数量 | 已通过内容 | 临时脚本 |
| --- | --- | --- | --- |
| Composer 处理器 | 7 项 | 匿名按钮保存草稿并跳转登录，零 UUID/写 Action；存储失败阻止跳转并保留输入；服务端会话失效转中性登录续写；无匹配不显示相似标题；真实匹配展示且改标题立即清除；旧请求晚到不覆盖新搜索；异账户结果不展示 | `/tmp/feedback-followup-component-qa.mjs` |
| Server Action | 7 项 | 匿名、换账户、缺 profile、伪管理员、禁言、黑名单均在 RPC 前拒绝；合法同账户仅调用一次模拟写 RPC | `/tmp/feedback-followup-actions-qa.cjs` |
| 草稿存储 | 5 组 | owner 隔离及一次性消费、显式认领匿名草稿、kind/帖子隔离、30 分钟过期、未来时间失效 | `/tmp/feedback-followup-draft-qa.cjs` |
| 前端旧 RPC 名称兜底 | 9 例 | 完整/截断/缩写 `0x` 地址、邮箱、空值被隐藏；中文昵称及去首尾空格正常 | `/tmp/feedback-followup-name-qa.cjs` |
| 0026 PostgreSQL | 6 组（含 11 例名称投影） | 迁移可应用；原函数 ACL/definer/search_path 完全相同；helper 不可由客户端直接调用；论坛名称回退；匿名与管理员隐藏过滤保持；底表/投票者读取仍拒绝 | `/tmp/feedback-followup-db-qa.mjs` |

合计 28 个非数据库用例及 6 组数据库检查。测试使用 `/tmp/imtoken-feedback-qa/node_modules/@electric-sql/pglite/dist/index.js`，通过 `FEEDBACK_QA_PGLITE` 指定；临时脚本不是仓库长期测试资产。完整构建、i18n 与浏览器中英/移动端可视验收由主调度记录，本文不代替或重复其结果。

## 权限和数据完整性复核

- `src/app/actions/feedback.ts` 的 `getUser()`、`expected_user_id`、profile、管理员角色、禁言和黑名单校验维持原行为，客户端登录提示没有成为唯一授权边界。
- `0026` 仅替换 `feedback_card`/`feedback_read` 中三处名称表达式；与 `0025` 比对，筛选、分页、隐藏内容、审计和投票可见范围未变化。未更新 profile、帖子、评论或既有互动数据。
- 新纯函数 `feedback_forum_name(text,text)` 对 PUBLIC、anon 和 authenticated 撤销 EXECUTE。原私有 helper 维持不可执行，已有 card/read/write 的 ACL、SECURITY DEFINER 和固定 search_path 实测逐项一致。
- 临时数据库包含已合并源帖、隐藏父评论和公开回复。匿名列表、详情、源帖、评论正确投影论坛用户名；隐藏父作者返回 null、隐藏帖拒绝、审计不泄露；管理员仍可查看隐藏内容及父作者。
- 迁移回退可恢复 `0025` 的 card/read 定义，无需删除用户数据。

## 范围与未验证项

- 地址识别当前覆盖 Ethereum `0x` 完整/截断/缩写格式及邮箱；Tron、BTC 等其他链地址未作通用识别，不应声称所有钱包地址格式均已覆盖。
- 未执行目标库 `0026`；未以真实账户完成「登录返回 → 恢复草稿 → 成功发布」端到端验证；未验收真实 OAuth、账号切换浏览器行为或并发数据库会话。模拟成功不等于真实发布成功。
- 既有草稿工具对损坏 JSON 的处理不是本轮修改范围；组件可捕获并显示草稿不可用提示。未发现由本轮变更引入的越权恢复。
