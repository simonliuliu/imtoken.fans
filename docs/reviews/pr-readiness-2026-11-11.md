# PR 合并就绪核对

2026-11-11 根据用户要求核对当前 GitHub 状态。基线为主线 `67da8fe09c375245eac858caec415adc28390613`，对应 Production deployment `7596104855` 已成功；该版本此前已在聊天汇报。分支预览成功只表示预览构建成功。

| PR | 用途 | 当前状态与下一步 |
| --- | --- | --- |
| [#41 论坛反馈](https://github.com/simonliuliu/imtoken.fans/pull/41) | 论坛反馈入口和可追溯队列 | 有用；正式库函数指纹/ACL、历史计数等只读预检不完整，0031/0032 未执行。完成目标核对、预检、受控迁移与后检后再合并。 |
| [#42 审核一致性](https://github.com/simonliuliu/imtoken.fans/pull/42) | 后台审核、队列与经验一致性 | 有用；依赖 #41，尚须同步主线、合入已验证的窄屏修复，并完成 0033 预检和迁移。 |
| [#43 回复与通知](https://github.com/simonliuliu/imtoken.fans/pull/43) | 回复分页和通知跳转 | 有用；已完成隔离回归，按既定顺序在 #41/#42 发布后同步、验证并合并。 |
| [#45 限制竞态](https://github.com/simonliuliu/imtoken.fans/pull/45) | 活动写入与黑名单处分的事务一致性 | 有用；目前与主线冲突，依赖前序批次与 0034 预检/迁移，不能以 Preview 代替正式库验收。 |
| [#47 媒体](https://github.com/simonliuliu/imtoken.fans/pull/47) | 反馈图片、视频及审核 | 有用但仍在开发；表单与审核界面、真实 Storage/TUS、并发和播放验收未完成，候选迁移未执行。 |
| [#48 依赖安全](https://github.com/simonliuliu/imtoken.fans/pull/48) | 修复框架和依赖安全公告 | 有用；框架、重定向和根级 Zod 4 候选已更新，钱包内 Zod 3 仍有高危审计告警，审计退出码非零，不能称安全检查完成。 |

以上 PR 均为草稿。没有把 GitHub 显示的 `MERGEABLE` 或 Preview 成功当成正式数据库、业务、安全和生产部署验收。

另核对发现 [#35](https://github.com/simonliuliu/imtoken.fans/pull/35)、[#36](https://github.com/simonliuliu/imtoken.fans/pull/36)、[#37](https://github.com/simonliuliu/imtoken.fans/pull/37)、[#38](https://github.com/simonliuliu/imtoken.fans/pull/38) 均已由仓库所有者关闭，`mergedAt` 为空；本次没有重新打开或改写。#35 的本地隔离环境及 #38 的活动能力并未完整进入主线，后续只能在既有授权范围内按实际依赖复用，不能假定已合并。#36 的早期路演内容被 #37 包含，#37 的路演站此前独立发布，不等于社区主站已合并该分支。

当前没有在未完成迁移、发生冲突或安全检查失败时合并。后续有条件时继续沿已有 #41 → #42 → #43 → #45 → #47 顺序处理；每次合并后核对精确主线 Production，异常先处理再继续。
