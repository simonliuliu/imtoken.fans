# 反馈页 Review 三项修复与验收

2026-10-16。基线 main `4e1f417`，分支 `codex/feedback-review-fixes`。用户要求先完成三项缺陷及当前反馈页回归，图片/视频留下一阶段。

## 最终行为

1. **持续草稿**：输入变化同步保存到当前标签页的 sessionStorage，刷新、语言切换、相似反馈返回均恢复。独立 `product-feedback-v2` key 避免旧 Composer 消费新版结构；按账号隔离，匿名草稿只有明确的 resume 登录续写才能认领。普通未提交草稿30分钟过期，单纯打开不会续期；未确认请求持续保留到结果确认。读取失败会锁住表单并提供「重新读取草稿」，不能用新输入覆盖旧待确认请求。
2. **可靠重试**：发请求之前先保存不可变原始 payload 与 UUID。网络/未知失败后锁住字段，提供「重试并确认原提交」和查看反馈；刷新/切语言保留原序列化内容和编号，不因语言重新拼正文。成功后清理草稿、跳转一次；重复点击和旧账号晚到响应被隔离。旧版仅有UUID的草稿可明确选择使用原编号重试：未保存可创建，已有不同内容仍提示冲突并提供原反馈链接，不自动另建一条。
3. **数据库校验**：新增 `0029_feedback_text_validation.sql`，trim涵盖JavaScript String.trim的空白字符，拒绝纯换行、Tab和Unicode空白。写RPC只替换原trim调用，权限、advisory lock、幂等、合并逻辑保持；新增NOT VALID约束防止后续特权直接写入绕过。历史行不改写。

## 已完成的验证

| 检查 | 结果 |
| --- | --- |
| 当前ProductFeedbackForm真实处理器回归 | **26/26**，mock认证/路由/Action/浏览器存储；涵盖全部字段、恢复/过期/损坏/不可用、账号、匿名认领、跨语言不可变快照、重复点击、失败/成功、旧UUID恢复。不是只测旧ComposeDemoButton。 |
| 新SQL隔离回归 | **28/28**，临时PGlite应用0025/26/29；全部25种JS空白、create/edit/comment/edit_comment、边界多行中英、ACL、管理/禁言/黑名单、同ID幂等及切号、6表历史逐行等值、回退。 |
| 独立QA额外负向复测 | **6/6**，实际新组件处理器：初始读失败→显式恢复、legacy存储失败及原ID、跨语言隔天重试、成功清理失败仍幂等、A卸载+B切号晚响应、早期无retain属性的过期pending。额外实验位于临时目录，不冒充仓库长期回归资产。 |
| 旧Composer兼容 | **12/12**，共享草稿工具的一次性消费者继续可用；不代替当前页26项。 |
| i18n / lint / 生产构建 | 中英文键/占位符检查通过；无错误无警告lint通过；`npm run build -- --webpack`成功，含TypeScript与68页生成。构建有既有分享图maxWidth=none提示，不阻断且本批未改该资源。 |
| 实际浏览器 | 中文桌面1280、英文390px，页面宽度等于视口无溢出；匿名填写→刷新→EN→相似详情→返回完整保留；本地虚拟账号登录resume恢复；模拟已保存但返回503→锁定→中文切换→刷新→原样重试进入同一ID；fixture记录数重试前后均2（1种子+1新提交），没有重复；成功再进表单为空。 |

独立QA曾发现「初始读取失败后新编辑覆盖pending并换UUID」的P2，已修成初始化失败时禁止编辑/提交，明确重新读取后才继续，独立复测通过。最终无未修复阻断项。

## 可查看效果

[本地修复表单](http://localhost:3000/zh/submit/feedback)。浏览器留有一份可编辑示例，直接刷新或切换语言可检查保留效果。此预览使用本机虚拟账号和内存反馈服务，所有写入只在测试进程内；没有正式Supabase凭证，也未操作正式账号。关闭标签页会结束sessionStorage草稿；不是跨设备云草稿。

- [中文桌面恢复后](screenshots/feedback-review-fixes/zh-desktop-restored.jpg)
- [英文390px恢复后](screenshots/feedback-review-fixes/en-mobile-restored.jpg)
- [英文未知结果锁定](screenshots/feedback-review-fixes/en-retry-locked.jpg)
- [切中文并刷新仍保留待确认提交](screenshots/feedback-review-fixes/zh-retry-after-reload.jpg)
- [原编号重试成功](screenshots/feedback-review-fixes/zh-retry-confirmed.jpg)

本机重复运行（不依赖正式库）：

```sh
node scripts/tests/product-feedback-form.mjs
FEEDBACK_QA_PGLITE=/private/tmp/imtoken-feedback-qa/node_modules/@electric-sql/pglite/dist/index.js node scripts/tests/feedback-text-validation.mjs
node scripts/tests/feedback-compose.mjs
npm run check-i18n
npm run lint
npm run build -- --webpack
```

SQL测试依赖既有临时PGlite路径；其他机器需自行提供该测试依赖位置，未把它加进生产依赖或锁文件。预览已在3000启动（用户明确授权停止原服务）。如需重启，确认3000和54329空闲，分别运行：

```sh
node tests/helpers/feedback-api.mjs
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54329 NEXT_PUBLIC_SUPABASE_ANON_KEY=local-test-public-key NEXT_PUBLIC_SITE_URL=http://localhost:3000 npm run dev -- --webpack
```

测试登录用 `reader@example.test` / `local-test-password`，均为虚构fixture，不是正式账号。可通过本机服务的 `POST /test/lose-next-response` 让下一次反馈保存后返回失败，再通过 `GET /test/summary` 比较数量；这些路由只存在独立测试进程，不打包成产品API。

## 迁移与发布边界

**0029尚未在目标Supabase执行，修复尚未合入/部署正式站。** 当前可确认代码修复和本地/隔离验证完成，不能把原线上RPC称为已修复。

部署前应在受控事务中先记录反馈6表与函数ACL/定义，应用0029，再核对历史逐行、角色权限和实际PostgREST写入；旧空白记录保留，但对其隐藏或修改metadata时也必须同时修正无效文本（NOT VALID仍检查后续更新）。本批未连接目标库核对这类历史记录数量。

回退：恢复0025原feedback_write定义，删除0029新增的三个CHECK约束，再删除feedback_text_trim函数；保留所有反馈/评论/支持/合并/审计数据。自动化回退检查已在临时库验证。

未验证：目标Supabase/PostgREST迁移与真实多连接并发、真人OAuth/钱包、修复版在正式账号上的端到端写入。上一轮已登录生产测试证明旧版发布持久化，本轮没有再往正式站发布。图片/视频上传、类型结构化、通知/完整处理闭环仍属后续，未扩展。
