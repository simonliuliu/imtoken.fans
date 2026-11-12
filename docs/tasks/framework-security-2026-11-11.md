# 框架依赖安全修复候选

日期：2026-11-11。工作目录：`/Users/simonliu/.codex/worktrees/forum-next-security/imtoken.fans`；分支：`codex/next-security-patch`。从已发布主线 `67da8fe09c375245eac858caec415adc28390613` 创建，属于现有上线安全检查，不替代论坛反馈、治理或媒体任务。

## 发现与范围

- 主线锁定 Next.js 16.3.8，命中三个 Next 安全公告。独立 QA 确认项目使用 App Router 和 Server Actions，符合 [Server Actions 拒绝服务公告](https://github.com/advisories/GHSA-p3m5-59mp-jv5r)列出的代码前提；没有进行线上攻击测试。
- [图片优化公告](https://github.com/advisories/GHSA-2464-fhr4-w9xw)列出的官方缓解是 Sharp 0.35.5 或更高，主线锁定的 Sharp 是 0.35.5；生产实际 native 运行状态未核验。[缓存组件公告](https://github.com/advisories/GHSA-673q-mjm6-r5xr)要求使用 Cache Components 和特定 `use cache` 返回值，主线代码未发现相关配置。以上结果不能宣称线上已发生或可实际利用远程代码执行。
- 候选将 Next 与对应 ESLint 配置同步从 16.3.8 升至 16.4.6，并在上游允许范围内将 `follow-redirects` 从 1.16.0 升至 1.16.3。根级 Zod 4.4.3 同主版本升级至 4.6.7，并显式固定以满足 abitype 的可选 peer；钱包内部的 Zod 3 保持原版本。没有数据库迁移、业务文案或功能变更；钱包 SDK、React、viem、Sharp 保持原版本，没有将 Zod 3 强制替换为 Zod 4 或降级钱包 SDK。
- 锁文件另由 npm 补录 6 个 Tailwind WASM 内部的 dev/optional/inBundle 节点，父包版本未变。独立 QA 核对了版本、依赖树及 registry integrity。

## 检查与限制

- 使用 `npm ci` 按候选锁文件安装；中英 1569 键、lint、Webpack 构建及构建后 TypeScript 检查通过。构建保留既有 OG `maxWidth: none` 提示。
- 登录、会话和通知等隔离回归 90 项通过。Chrome 本地虚构账号/API 的 19 项登录与产品会话用例首次 16 项通过、3 项失败；在原 Next 16.3.8 且相关源文件一致的基线复现了同三项。旧测试仍假设旧投稿路由直接跳登录，现行逻辑是转至 `/submit/product` 并显示登录入口；修订为验证当前路径、登录回跳和权限。重跑受影响的 3 项通过。独立 QA 指出其中慢资料返回测试需等待真实夹具响应，补充响应完成屏障及两帧后再断言，单项重跑通过并经独立复核。
- 本地认证夹具在首页提供了不完整的模拟帖子，开发日志出现 `community.sections.undefined.name` / `community.categories.undefined`；该夹具提示在升级前后均出现，不能作为真实数据或线上缺陷已复现的证据。
- 独立 QA 的精确差异、公告和锁文件复核未发现本候选依赖差异方面的阻塞。使用本地 `next start` 生产构建及虚构 API，独立复核中英首页/登录/投稿、旧入口跳转、投稿登录回跳、中文 320px/英文 390px、未登录后台拒绝、普通登录 Action、PNG 优化、外部图片白名单、API gzip/JSON 和 nonce cookie 均通过；浏览器公共配置为空时，完整浏览器登录未验证，只有虚构 API 的 Action 验证。全空服务端配置访问后台返回 500；改用本地虚构 API 配置后验证未登录拒绝正常。真实钱包扫码、钱包签名、Google OAuth、正式数据库、真实账号及移动设备未验收。
- 根级 Zod 更新后，实际 abitype 地址/ABI 正反向校验、临时虚构签名验证、WalletConnect 模块导入以及带上界的大数组提前拒绝通过。独立 QA 在隔离进程复核有效及无效 ABI、嵌套 tuple 和 20,000 项受限数组；未调用真实钱包或远程服务。该上游修复不会自动限制没有上界的集合。

## 尚未解决的安全检查

原主线生产依赖审计有 1 个 critical、12 个 high 包节点；候选消除 Next critical 告警和 `follow-redirects` high 告警后仍有 **11 个 high 包节点**，沿钱包/AppKit/Coinbase/abitype 传播到 [Zod 大型数组资源消耗公告](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)，不等于 11 个互相独立的漏洞。升级根级 Zod 后，审计列出的 Zod 受影响安装位置从三处减至钱包内的两处；包节点数仍为 11，审计退出码非零。该增量以前全量审计另有 8 个 moderate 开发依赖节点；现状见下方增量记录。自动修复预演当时仍报告这些告警；钱包上游含 Zod 3 精确/主版本范围，不能安全地全局强制替换为 Zod 4，也不能用 `npm audit fix --force` 未经验证地回退钱包 SDK。[上游记录](https://github.com/colinhacks/zod/issues/6653)说明 v3 不再发布新版本。

独立 QA 在隔离输入下确认，两个钱包依赖内的 Zod 3 仍可能随无效集合放大错误数量。当前应用使用的 WalletConnect basic 模式没有发现实例化完整 AppKit 的邮件/社交 frame 或调用 Coinbase 策略写入的路径；这不证明所有供应链调用均不可达。完整 AppKit 的上游 frame 消息监听在隔离样本中存在来源未先校验的潜在入口，目前未确认本站当前可利用；以后启用邮件/社交或新增策略/支付功能前须重新审查消息来源和输入大小。实际可达性和兼容修复仍待进一步核验，审计未通过，不能称安全告警已清零。

该候选尚未合并或发布。保留现有 Production、凭证与历史数据；在剩余安全检查和必要独立 QA 完成前保持草稿。随后按既有单队列继续处理 #41、#42、#43、#45 与 #47，不跳过其数据库预检和迁移依赖。

用户要求统一检查并合并有用 PR；逐项状态与未合并原因见 [PR 就绪核对](../reviews/pr-readiness-2026-11-11.md)。

## 2026-11-11 开发依赖检查增量与钱包替换可行性

- 开发依赖 `@typescript-eslint/typescript-estree` 的 `minimatch` 10.2.6 命中 [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)，上游 10.x 没有公告列出的修复版本。只对这一依赖路径增加明确的 npm override，使用 11.0.8；其余 `minimatch` 和钱包依赖不变。该限定覆盖超出上游 `^10.2.2` 的主版本范围，属于临时兼容措施，不能泛化成所有使用方均兼容。官方 11.x 删除若干旧 API 并调整部分 glob 行为；320 组隔离比较中 `**/a/b/c/**/d/**` 有 1 组差异，对应官方记载的旧版匹配修正。当前 typescript-estree 仅在 projectService 白名单调用 `minimatch(filePath, pattern, { dot: true })`，本项目 ESLint 配置未启用该路径；日后启用 projectService 或升级上游时需重新核对。11.0.8 要求 Node 20 或 >=22，项目 `.nvmrc` 为 22.23.3；本地主要检查使用 Node 22.23.4，独立 QA 另用项目二进制 22.23.3 复测解析器回归。
- 此增量 `npm ci`、中英 1,569 键、lint、Webpack 生产构建/TypeScript 与 projectService 白名单 3 项正反回归通过。独立 QA 对限定 override、注册源/integrity、调用位置、主版本差异和版本要求无 P0/P1 阻塞。全量 `npm audit` 从此前的 8 moderate + 11 high 变为 0 moderate + 11 high；退出码仍为 1，11 个 high 仍是钱包链上的 Zod 3 传播节点。不能称审计通过，也不能据此合并。
- 在 `/private/tmp/imtoken-wallet-probe.a70IT3` 用当前候选的完整依赖清单和锁文件做隔离方案实验：用 `@walletconnect/universal-provider@2.26.0` 配本地 `qrcode.react@4.2.0` 替代现有 `@walletconnect/ethereum-provider`；没有将此方案写入项目或上线。实验 `npm ci --ignore-scripts`、模块导入和本地 SVG 生成通过；该实验树的生产 audit 为 0，连同上述开发依赖 override 的另一个锁文件实验中全量 audit 为 0。二者只证明所测试时点的依赖解析与审计结果，不能证明钱包连接或生产安全已验收。
- 独立 QA 使用真实 Universal Provider 包、虚构 SignClient、临时随机签名账号并封锁网络：二维码生成、模拟配对签名与断开、取消后晚到批准 3 项观察均与测试预期一致；最后一项证实取消函数本身不能阻止晚到批准。进一步负例确认该版 `abortPairingAttempt()` 是 no-op；而请求的 namespace 转为 optional，连接成功也可能没有批准 `personal_sign` 或只批准其他链。未来集成必须基于实际批准 session 校验链、账号和方法，并对取消、超时、旧尝试后的 nonce/签名/验证/跳转设置隔离及晚到会话清理；验证请求发出后取消的会话写入竞态也要单独设计。虚构 SignClient 不代表真实授权校验或真实网络会话；二维码图形仍编码配对机密，本地 SVG 不含明文 URI 也不代表防泄漏。以上是替代方案的 P1 前置条件，不是当前线上漏洞已经被利用的证据。
- 本轮沿既有 Claude 设计渠道请求一个扫码弹窗设计交接，模型请求 `devin/claude-opus-5-5` / `low`，返回 15,647 输入、3,577 输出 token；渠道接受请求不等于核验其内部路由。方案建议沿用现有入口、本地二维码和明确的取消/重试状态，并指出移除原钱包列表与移动深链可能影响同设备连接。未采纳为生产实现；真实扫码/签名、手机深链、取消并发、会话清理、无障碍及隐私/遥测验收仍待完成。

## 2026-11-12 钱包会话授权增量

- 当前候选仍使用既有 `@walletconnect/ethereum-provider`，没有更换钱包 SDK 或扫码界面。新增会话检查：在请求 nonce 前、nonce 返回后及签名返回后，核对未过期的实际 session 已授权以太坊主网、当前账户及 `personal_sign`，同时要求 provider 当前链与账户一致。缺失、过期、不一致或异常大的授权列表按失败处理；中英文错误提示同步。服务端仍独立校验 nonce 与真实签名，前端校验不替代身份验证。
- 独立 QA 发现初版仅核对 session 链而未核对 provider 当前链；已增加初始、nonce 等待和签名等待期间的链变化保护，并独立复核。钱包授权隔离回归 23 项通过；初跑的 20 项有 1 项因测试夹具把显式 `undefined` 替换为默认有效 session 而失败，修正夹具后重跑通过，再追加 3 项链变化测试。中英 1,570 键、lint、Webpack 构建/TypeScript 通过，构建保留既有 OG 图片提示。
- 独立 QA 对链相关 6 项复测通过，另以真实 wallet-client、nonce/verify 路由、HMAC 与 viem 临时密钥验证中英正确签名、错误签名和 nonce 覆盖共 5 项；HTTP、cookie、用户和 OTP 存储均为内存夹具并阻断外网。可复现脚本为 `tests/unit/walletconnect-identity-flow.mjs`；虚构账号和内存存储不代表真实钱包、浏览器 cookie 或 Supabase 验收。
- verify 请求发出后，前端撤权、关页或取消不能保证撤销服务器已发生的会话写入；本增量未解决取消、晚到响应、并发及旧尝试的完整隔离。真实钱包扫码、签名、手机设备仍待验收。两个钱包 Zod 3 安装位置与 11 个 high 传播节点未改变，audit 仍非零，[PR #48](https://github.com/simonliuliu/imtoken.fans/pull/48) 继续为草稿，尚未发布。

## 2026-11-12 钱包登录并发保护增量

- 两种钱包登录入口共用同一个登录锁，持锁范围包含连接、nonce、签名、verify 和 WalletConnect 的断开清理。支持 Web Locks 的浏览器以非排队方式拒绝同一存储桶及同源下已持锁的另一请求；锁访问失败或请求启动失败时不执行登录，返回中英文提示。缺少 Web Locks 时仅保护当前 JavaScript 模块实例，不声称可协调其他标签页或其他模块副本。
- 锁与会话授权隔离回归共 33 项、真实客户端与路由的虚构身份密码学流程 5 项通过。独立 QA 发现锁请求 getter 抛错时会暴露浏览器原始错误，已改为仅读取并绑定一次、统一返回不可用提示；QA 对 getter 和异常释放复测 7 项，以及锁覆盖 verify/断开、无锁跨标签边界等负例通过。中英 1,572 键、lint、Webpack 构建/TypeScript 通过；构建保留既有 OG 图片提示。
- 隔离 WebKit 27.2 以拦截的虚构页面验证两个同源标签互斥、首个释放后重试及不同 origin 不共享锁；未登录真实账号、未连接真实钱包、未访问生产服务。浏览器检查只验证该浏览器实例，不代表真实手机或其他浏览器版本。
- 两个标签必须都运行新代码且处于同一存储桶及 origin，旧标签、不同 origin 或不同端口不会共享 Web Lock；cookie 可能跨端口共享，不能把跨 origin 情形当成受保护。浏览器不支持 Web Locks 时只有模块实例内互斥。关闭或冻结页面、已发出的 verify、服务器会话写入及旧响应仍有边界，现有增量不保证取消或跨浏览器完全串行。钱包 Zod 3 的 11 个 high 审计传播节点未减少，audit 仍非零，PR #48 继续草稿，尚未发布。
