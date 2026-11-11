# 框架依赖安全修复候选

日期：2026-11-11。工作目录：`/Users/simonliu/.codex/worktrees/forum-next-security/imtoken.fans`；分支：`codex/next-security-patch`。从已发布主线 `67da8fe09c375245eac858caec415adc28390613` 创建，属于现有上线安全检查，不替代论坛反馈、治理或媒体任务。

## 发现与范围

- 主线锁定 Next.js 16.3.8，命中三个 Next 安全公告。独立 QA 确认项目使用 App Router 和 Server Actions，符合 [Server Actions 拒绝服务公告](https://github.com/advisories/GHSA-p3m5-59mp-jv5r)列出的代码前提；没有进行线上攻击测试。
- [图片优化公告](https://github.com/advisories/GHSA-2464-fhr4-w9xw)列出的官方缓解是 Sharp 0.35.5 或更高，主线锁定的 Sharp 是 0.35.5；生产实际 native 运行状态未核验。[缓存组件公告](https://github.com/advisories/GHSA-673q-mjm6-r5xr)要求使用 Cache Components 和特定 `use cache` 返回值，主线代码未发现相关配置。以上结果不能宣称线上已发生或可实际利用远程代码执行。
- 候选将 Next 与对应 ESLint 配置同步从 16.3.8 升至 16.4.6，并在上游允许范围内将 `follow-redirects` 从 1.16.0 升至 1.16.3。没有数据库迁移、业务文案或功能变更；钱包 SDK、React、viem、Sharp 保持原版本，没有强制替换 Zod 或降级钱包 SDK。
- 锁文件另由 npm 补录 6 个 Tailwind WASM 内部的 dev/optional/inBundle 节点，父包版本未变。独立 QA 核对了版本、依赖树及 registry integrity。

## 检查与限制

- 使用 `npm ci` 按候选锁文件安装；中英 1569 键、lint、Webpack 构建及构建后 TypeScript 检查通过。构建保留既有 OG `maxWidth: none` 提示。
- 登录、会话和通知等隔离回归 90 项通过。Chrome 本地虚构账号/API 的 19 项登录与产品会话用例首次 16 项通过、3 项失败；在原 Next 16.3.8 且相关源文件一致的基线复现了同三项。旧测试仍假设旧投稿路由直接跳登录，现行逻辑是转至 `/submit/product` 并显示登录入口；修订为验证当前路径、登录回跳和权限。重跑受影响的 3 项通过。独立 QA 指出其中慢资料返回测试需等待真实夹具响应，补充响应完成屏障及两帧后再断言，单项重跑通过并经独立复核。
- 本地认证夹具在首页提供了不完整的模拟帖子，开发日志出现 `community.sections.undefined.name` / `community.categories.undefined`；该夹具提示在升级前后均出现，不能作为真实数据或线上缺陷已复现的证据。
- 独立 QA 的精确差异、公告和锁文件复核未发现本候选依赖差异方面的阻塞。使用本地 `next start` 生产构建及虚构 API，独立复核中英首页/登录/投稿、旧入口跳转、投稿登录回跳、中文 320px/英文 390px、未登录后台拒绝、普通登录 Action、PNG 优化、外部图片白名单、API gzip/JSON 和 nonce cookie 均通过；浏览器公共配置为空时，完整浏览器登录未验证，只有虚构 API 的 Action 验证。全空服务端配置访问后台返回 500；改用本地虚构 API 配置后验证未登录拒绝正常。真实钱包扫码、钱包签名、Google OAuth、正式数据库、真实账号及移动设备未验收。

## 尚未解决的安全检查

原主线生产依赖审计有 1 个 critical、12 个 high 包节点；候选消除 Next critical 告警和 `follow-redirects` high 告警后仍有 **11 个 high 包节点**，沿钱包/AppKit/Coinbase/abitype 传播到 [Zod 大型数组资源消耗公告](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)，不等于 11 个互相独立的漏洞。全量审计另有 8 个 moderate 开发依赖节点。自动修复预演仍报告这些告警；钱包上游含 Zod 3 精确/主版本范围，不能安全地全局强制替换为 Zod 4，也不能用 `npm audit fix --force` 未经验证地回退钱包 SDK。实际可达性和兼容修复仍待进一步核验，审计未通过，不能称安全告警已清零。

该候选尚未合并或发布。保留现有 Production、凭证与历史数据；在剩余安全检查和必要独立 QA 完成前保持草稿。随后按既有单队列继续处理 #41、#42、#43、#45 与 #47，不跳过其数据库预检和迁移依赖。
