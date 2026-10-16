# Dangerous 告警排查与复审准备

2026-10-16。状态：Google 已确认不安全标记，初步修正和站点验证文件准备完成；待所有者合并发布后验证 Search Console、读取具体 URL 并完成修复/复审。**尚未解除告警。**

## 已验证事实

- 用户截图域名：`imtoken-fans.vercel.app/zh`，浏览器显示 Dangerous。
- Google Transparency Report 对主机的最终查询：**This site is unsafe**，包含 **Try to trick visitors into sharing personal info or downloading software**。日期 Oct 16, 2026；[截图](../reviews/screenshots/site-dangerous/google-status.png)。此前页面曾显示 No unsafe content found，重新查询得到 unsafe，以最终结果为准，不能认定误报。输入完整 `/zh` 一度返回 No available data，不等于安全。
- 线上首页 HTTPS200，证书校验成功，Vercel提供，HSTS已启用；页面脚本src均为本站 `/_next/`，未观察到首页跳去其他站。
- GitHub Production 部署对应主线 `4e1f4178c56f790639dabb184e704bd644668b5d`，状态success。审计本任务从最新主线开始。5780e90是其他任务Preview，不混入本批。
- 当前已登录 Google 账号尚无该 URL-prefix Search Console 资源的所有权，无法读取安全问题的具体URL。已通过Google界面取得验证HTML文件，未提交误报表单。

## 独立只读安全审计

- 没有发现助记词/私钥收集、转账、approve/setApprovalForAll或任意脚本注入路径。
- 钱包使用用户触发的 eth_requestAccounts 和 personal_sign 登录挑战；帖子评论通过React文本输出，产品网址仅HTTP/HTTPS且强制审核，登录回跳限制站内。
- npm audit --omit=dev --ignore-scripts：0个已知生产依赖漏洞。这些局部检查不能证明整站绝对安全或排除数据库中的恶意投稿。
- 确认钱包弹窗仍为imAihunt与Next.js图标，身份显示不一致。本批修复；未证明它就是Google标记原因。
- 首页数字币人外链为 `https://bman.buidl4.top/c/general`；当前未证明其恶意，不擅自删除用户指定功能。
- 发现签名缺少显式origin/domain绑定，需单独登录加固任务和回归；本批不改变挑战协议，避免把大范围登录变更当成Google解封修复。

## 本批修改与检查

- WalletConnect metadata 与签名显示品牌统一imToken Fans，图标使用真实存在的 `/icon`，无旧账号ID迁移。
- 登录页面中英说明：社区账号不是钱包恢复/解锁，使用独立社区密码，不输入钱包密码/助记词/私钥。
- `public/googlecf55aec2fc10737a.html` 是Google提供的公开所有权文件；proxy仅对精确 `/google`+16位十六进制+`.html` 绕过语言与session刷新，不绕过任何后台/API权限。
- i18n1541键、lint、build/TypeScript通过。构建已有品牌图片 maxWidth:none 警告，与本批无关。
- 本地验证HTML200、无语言跳转且正文匹配；/icon为200 image/png；中英文登录页200并含相应说明。
- QA用内存随机钱包执行实际挑战生成/签名/验签，中英通过，错地址/篡改cookie拒绝；proxy实际代码验证正常后台/API/语言路径仍刷新session。没有真实账户/数据库测试写入。
- 更换签名显示品牌时，部署前签发的5分钟挑战可能需要重试，不删除用户或历史数据。

## 上线后继续执行（未完成）

1. 所有者合并本PR，等待正式部署Ready，验证公开HTML路径实际200且无跳转。
2. 回到Search Console所有权弹窗点验证；打开安全问题报告，保存具体分类及示例URL，检查所有相关内容与外链，必要时继续修复。
3. 确认实际问题已处理后，通过Search Console请求安全审核；若报告没有示例URL或显示无问题但仍有告警，再提供上述证据向Safe Browsing报告。
4. 不关闭Safe Browsing、不用新域名掩盖告警、不宣称改了品牌就已解封。等待Google复审，重复检查公开报告与浏览器实际状态。

官方依据：[Chrome告警说明](https://support.google.com/chrome/answer/99020)、[Search Console安全问题](https://support.google.com/webmasters/answer/9044101)、[复审流程](https://web.dev/articles/request-a-review)。
