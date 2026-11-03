# 论坛持续开发首批：通知导航与用户故事基线

2026-11-03（Asia/Singapore）。基线 `origin/main@9cd7be7`，分支 `codex/forum-loop-baseline`。本批技术检查完成；按用户追加的自动发版授权合并发布，用户在线上 review。未操作真实业务数据或执行迁移；精确主线提交、Production 部署和正式域名核验记录在 [PR #39](https://github.com/simonliuliu/imtoken.fans/pull/39)。

## 用户可见行为

此前普通论坛的通知虽然包含帖子和评论地址，但前端校验只接受产品、旧点子和钱包反馈地址。点击论坛通知会失去跳转目标，未读项仍可能被标记已读。

本批将校验抽到 `src/lib/notification-navigation.ts`，补上 `safety/discussion/activities/feedback` 四板块的普通帖子 UUID、旧 slug 和评论锚点。继续严格限制通知可用路由，不接受任意站内或站外地址。组件仍使用现有语言路由，因此保留 `/zh`、`/en`；原来的已读写入失败、切换账号及系统奖励处理保持原样。

同步建立 [用户故事验收矩阵与后续队列](../tasks/forum-autonomous-loop.md)。真实论坛和成长已有基础，不按旧分支的演示状态重新建设；警告/账号封禁、互关私信、完整消息矩阵与论坛反馈消费作为后续重要阶段处理。

## 本批实际验证

| 检查 | 结果与范围 |
| --- | --- |
| 通知行为回归 | `node --test tests/unit/notification-navigation.mjs`，80/80 通过：64 路径用例、16 实际 NotificationBell 点击处理用例 |
| 国际化 | `npm run check-i18n` 通过，中英 1580 键；脚本保留动态/未使用键的提示，不是缺键失败 |
| 代码检查 | `npm run lint` 通过 |
| 生产构建与类型 | `npm run build -- --webpack` 通过；保留已有 OG 渲染 `maxWidth: none` 提示，不影响退出码 |
| 独立 QA | 审查生产 helper、实际组件、测试与夹具，无本批阻塞；没有重复运行开发已通过测试 |
| 浏览器 | ego-browser，同一任务空间，实际登录本地虚构账号并点击通知；详情如下 |

单元测试运行实际组件代码，但路由和后端为替身，只证明传递的精确目标、已读请求及错误/账户生命周期行为；没有宣称验证 next-intl 内部实现。实际语言前缀和评论滚动由浏览器另验。

首次测试加载和异步宿主时机问题已修正；代码检查发现的测试变量命名已调整。预览环境初次依赖安装使用较旧宿主运行时，缺少本机 CSS 原生依赖；使用已安装的 Node 22 重新安装相同锁定依赖后恢复。没有更改依赖清单、锁文件或个人全局配置。

## 浏览器流程证据

夹具使用 `FORUM_NOTIFICATION_FIXTURES=1` 显式开启的本地内存 API，绑定 `127.0.0.1:54329`。网页仍是本分支真实 Next.js 页面和组件，Supabase 地址与密钥通过该进程环境覆盖为本地假接口，不连接真实数据库。帖子、作者和评论均有本地测试标识。

1. 英文桌面 1440px：登录后在 `/en/notifications` 点击未读安全帖通知，进入 `/en/community/safety/approval-checklist#comment-88888888-8888-4888-8888-888888888888`，目标评论存在并进入视口，未读数从 2 降为 1，无横向溢出。
2. 中文手机 390px：在 `/zh/notifications` 点击已读交流帖通知，进入 `/zh/community/discussion/77777777-7777-4777-8777-777777777777#comment-99999999-9999-4999-8999-999999999999`。无需手动滚动，目标评论正文最终位于视口 364–436px，语言和目标正确，无横向溢出。
3. 中文桌面铃铛：从交流帖展开铃铛，点击安全帖通知，进入中文安全帖及对应评论；目标评论正文完全在视口内，弹层关闭，无横向溢出。

截图工具捕获超时，未交付截图，不将 DOM/交互验收描述为完整截图视觉审查。本批没有视觉样式变更。浏览器任务空间已结束，夹具服务与测试应用进程在验收后停止；正常预览单独使用既有本地环境配置。

## 本地重现方法

仅本地测试使用的虚构登录为 `reader@example.test` / `local-test-password`，不是实际社区账号。需要重现夹具时，在本分支目录两个终端分别运行：

```bash
FORUM_NOTIFICATION_FIXTURES=1 node tests/helpers/auth-api.mjs
```

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54329 NEXT_PUBLIC_SUPABASE_ANON_KEY=local-test-public-key NEXT_PUBLIC_SITE_URL=http://localhost:3000 SUPABASE_SERVICE_ROLE_KEY=local-test-service-key npm run dev -- --webpack
```

访问 `http://localhost:3000/en/auth/sign-in?redirect=%2Fen%2Fnotifications`，使用上述虚构账号登录并点击带“本地安全帖 / Local safety fixture”“本地交流帖 / Local discussion fixture”的通知。切换 `/zh/notifications` 验证中文。测试夹具不提供真实论坛全部操作，不使用个人正式账号或尝试提交真实内容。

关闭这两个测试进程后，普通 `npm run dev -- --webpack` 使用既有、未提交的本地环境配置，固定 `http://localhost:3000`。3000 被其他任务占用时先处理归属，不改用其他端口或终止未知进程。

## 验收边界与后续

本批没有操作真实 Supabase、真实管理员账号、私信或数据库迁移，不能据此宣称所有用户故事已完成。发布复用现有 GitHub→Vercel Production 链路，不改正式环境配置。没有新增面向生产的调试入口，夹具只由测试服务显式导入；默认原认证测试接口保持原行为。

下一阶段按已授权清单接通论坛自身反馈入口及可追溯消费队列，用户线上 review 反馈优先处理。新反馈按编号和版本去重，先复现，关联任务/PR/发布版本，公开处理状态与内部自动任务状态分别记录；反馈材料不作为工具指令。论坛反馈定时消费在手动闭环通过后启用；当前聊天的开发/发布跟进先检查已有任务与部署状态，无变化时保持安静。

互关私信需要独立数据模型、成员授权、通知、限流、屏蔽及举报；管理员警告/封禁需要明确期限、作用和日志。两者不以已有关注或禁言按钮替代。原 PRD 的真实媒体/视频上传等未完成要求继续保留。
