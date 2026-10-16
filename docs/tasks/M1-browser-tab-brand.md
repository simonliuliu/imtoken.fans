# 浏览器标签品牌修正

2026-10-16。已完成本地验证，待 PR 审查。

- 中英文首页及继承默认元信息的页面标题统一为 `imToken Fans`，不附钱包社区描述；描述 metadata 保留。
- 从现有 `public/brand/imtoken-fans.png` 提取品牌标志，生成 favicon.ico（16/32/48）、icon.png（64）及 apple-icon.png（180），替换旧图标。
- 阅读 CONTRIBUTING 和安装版 Next.js app-icons 指南；从最新 origin/main 创建 codex/browser-tab-brand。
- check-i18n、lint、build（含类型检查）通过。
- localhost:3000 的 /zh 与 /en 实测 title 均仅 imToken Fans；head 输出三个新版图标URL，含内容哈希。已查看64px图标。
- 提交前远端 main 更新，暂存本任务文件后临时保存，同步主线并恢复；路线图追加记录冲突保留双方内容，重新执行工程检查。
- 不改其他页面自定义标题、正文品牌图或业务。未部署；旧浏览器图标缓存可能需刷新。
