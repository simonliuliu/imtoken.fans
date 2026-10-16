# 首页 bman Agent 入口 review

日期：2026-10-16。结论：本地代码、构建、桌面和手机浏览器检查通过；等待 PR 与用户 review。

## 交付

首页「数字币人」显示 ZEC、NEAR、牛来、TRON 四个 bman 现有 Agent，使用 YAML 中的公开头像；每个头像与名称链接对应 `https://bman.buidl4.top/agents/$<symbol>` 的 URL 编码地址。综合交流仍显示 BTC、ETH、NEAR、ZEC、牛来币五个本地预览按钮，没有改成外链。

## 检查结果

- `npm run check-i18n`：通过，en/zh 共 1580 个键；动态键未命中是信息提示。
- `npm run lint`：通过，无输出。
- `npm run build`：通过；保留仓库已有两条 `maxWidth: none` 警告。
- 四个头像源：HTTP 200，类型分别为 WebP/WebP/WebP/PNG。
- 路由编码：`%24ZEC`、`%24NEAR`、`%24%E7%89%9B%E6%9D%A5`、`%24TRON`。
- 中文桌面 1440×1000：四张头像实际加载，2×2，无横向溢出。
- 中文手机 390×844：四张头像实际加载，4 列，无横向溢出。
- 综合交流回归：五个原预览按钮存在，外链数为 0。

## 截图

- [中文桌面](screenshots/bman-agent-home/home-desktop-zh.png)
- [中文手机](screenshots/bman-agent-home/home-mobile-zh.png)

## 限制

生产 Agent 详情 URL 的源码路由已确认，但匿名 HTTP 请求会被现有 Cloudflare Access 302 到登录页；本批没有绕过 Access，也没有在认证后逐页验证详情内容。头像已在真实浏览器中直接加载。Ego Lite 提示有可选更新，本批未擅自升级。
