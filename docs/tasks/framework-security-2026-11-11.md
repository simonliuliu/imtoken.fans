# 框架依赖安全修复候选

日期：2026-11-11。工作目录：`/Users/simonliu/.codex/worktrees/forum-next-security/imtoken.fans`；分支：`codex/next-security-patch`。从已发布主线 `67da8fe09c375245eac858caec415adc28390613` 创建，属于现有上线安全检查，不替代论坛反馈、治理或媒体任务。

2026-11-13 主线更新：独立依赖补丁已由 PR #49 合并并发布到 main `779cb8e03a1ecd72fc8a8bc0272bf465756dc006`，Production deployment `7760530521` 成功；回复和通知修复此前由 PR #43 发布到 main `5eb16bdfbea61cdf3cd2e4601759daf8cc7d044c`。下方旧框架“尚未发布”描述是当时的历史，PR #48 继续承载尚未发布的钱包安全、兼容性及 0037 候选，不重复提取已上线依赖补丁。

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

## 2026-11-12 钱包替代方案的本地协议实验

- 在独立依赖目录使用官方 `@walletconnect/universal-provider@2.26.0` 和 `@walletconnect/sign-client@2.26.0`，通过本机模拟 relay 连接真实 SDK 两端；项目当前钱包 SDK、依赖锁文件和扫码界面没有改变。四个场景通过：临时虚构账号配对并完成真实 `personal_sign` 验签；钱包只批准无签名方法或只批准其他链时，当前项目会话 guard 拒绝；调用 `abortPairingAttempt()` 后晚到批准仍能完成，随后显式断开并观察钱包 `session_delete` 和双方 session store 删除。模拟 relay 接收的消息未出现虚构挑战明文或其十六进制形式；这不验证二维码或实际服务的隐私。
- 项目 Node 22.23.3 在 macOS `sandbox-exec` 下只允许本机回环网络，JavaScript 钩子进一步限定测试 relay 随机端口并拦截 HTTP；独立负例直接连接 `192.0.2.1:443` 得到 `EPERM`。SDK 在实验中 5 次尝试访问 `verify.walletconnect.org`，均被钩子拦截；此结果不代表真实环境没有验证服务或其他联网行为。系统规则允许其他回环端口，也不限制文件访问。
- 独立 QA 复测实际脚本的四个场景及源码 SHA256 `025480e8efc1caed4e467ec343a3f9b46682fe103e28593bd907ef983456de52`；用错误临时签名者、向模拟 relay 注入虚构挑战明文、清理期间未处理拒绝三个反例分别验证测试会失败。初版在清理前输出成功且只检查前端 session，QA 指出后已改为在清理后检查，确认双方 session 删除，并停止 SDK heartbeat 后自然退出。专项 lint 通过。
- 复测脚本为 `tests/experiments/walletconnect-universal-offline.mjs`；现有独立包目录是 `/private/tmp/imtoken-wallet-probe.a70IT3`。当前应从项目根目录以 `WALLETCONNECT_TEST_DEPS_ROOT=/private/tmp/imtoken-wallet-probe.a70IT3 sandbox-exec -p '(version 1) (allow default) (deny network*) (allow network-inbound (local ip "localhost:*")) (allow network-outbound (remote ip "localhost:*"))' ./node_modules/node/bin/node tests/experiments/walletconnect-universal-offline-runner.mjs` 运行。临时目录不属于仓库，重建时需隔离安装并核对这两个 SDK 的 2.26.0 版本。
- 模拟 relay 只实现本实验需要的消息，不验证生产 relay 的鉴权、重试、时序和多节点行为；只确认所测 session 删除，不保证 pairing 记录或全部 SDK 后台状态清理。真实钱包、扫码、手机深链、站点 nonce/verify、取消后的服务端会话竞态、二维码隐私及无障碍均未验收。现有钱包依赖中的两个 Zod 3 与 11 个 high 审计传播节点未改变，审计仍非零；PR #48 继续为草稿，不能合并或发布。

## 2026-11-12 钱包 nonce 防重放检查

- 独立安全 QA 发现主线 `67da8fe09c375245eac858caec415adc28390613` 已有的 P2 设计缺口：钱包 nonce 使用短期 HMAC cookie，verify 删除当前响应的 cookie，但没有在共享服务端原子记录该 nonce 已消费。持有有效期内同一 cookie 和对应有效签名，或能让浏览器重复发送二者的请求，可以重复通过应用自身的签名校验并再次进入生成 OTP 的流程。普通浏览器收到删除 cookie 响应后的重试被拒；仅有签名、任意地址或正常重试不足以证明账户接管。没有线上攻击或滥用证据。
- 隔离检查使用真实 HMAC、临时随机 EOA 签名、独立请求 cookie 副本和虚构 Supabase：顺序与并发重复请求均到达虚构 OTP 并各模拟两次 session 写入；真实 GoTrue 的令牌轮换与并发结果未验证，不能据此声称线上两次会话必定成功。错误签名没有产生虚构 session，错误签名后同一挑战的正确签名仍可成功。
- 当时的 `b0d1eb9` 候选只加固 cookie 解析：要求恰好两段，附加 `.suffix` 的别名被拒；原 cookie 的顺序及并发重放尚未修复。真实身份流程 5 项、受影响 lint 与 TypeScript 检查通过。当时的 `tests/experiments/wallet-nonce-replay-check.mjs` 在项目 Node 22.23.3 和禁止网络的 `sandbox-exec -p '(version 1) (allow default) (deny network*)'` 下，原 cookie 顺序和并发重放各返回两次 200，检查按设计退出码为 1；后续修复与复测见下节。
- 独立 QA 复核最终诊断及 parser，并用三个隔离内存控件验证测试：签名后按规范 nonce 模拟原子消费时通过；把重复请求改为 500 时仍失败；先消耗再验签导致错误签名烧掉挑战时失败。诊断脚本 SHA256 为 `9d37d29f86af43e40e95f2f97c835fd1bb1387690096826b50c758c0240b7e00`，parser 文件为 `9d8820f2735f0944c0ae9118a7644de4f1662ff4707e674741d0dd220876fde4`。控件只验证测试本身，并非真实数据库修复。
- 完整修复需在真实签名校验后、创建用户或生成/验证 OTP 前，通过共享后端对稳定 nonce 标识执行原子单次消费；冲突及存储异常均须失败关闭，后续 Auth 失败须重新获取挑战。不得以进程内 Map、浏览器锁或先查后写代替；不得仅对原始 cookie 字符串散列作为身份。应使用已验证的地址与 nonce 等规范字段，不存原始 cookie 或签名，设计受限服务权限及安全过期清理。正式迁移仍须确认目标库、权限和既有 0031–0036 顺序，隔离 PostgreSQL 多连接、权限、错误与后检通过后受控执行。截至 `b0d1eb9` 未新增或执行该迁移；后续新增的 0037 仍未在正式库执行，真实 Supabase 和手机钱包未验收。

## 2026-11-12 nonce 单次消费候选

- 当前候选在真实签名校验后、查找或创建用户及生成 OTP 前，调用只限服务端的 `consume_wallet_sign_in_nonce`；以现有服务端密钥和已校验的地址/随机 nonce 生成用途隔离的 HMAC 标识，不保存原始 cookie、签名或地址。重复消费返回失败；RPC 错误、异常或非布尔结果均失败关闭。若消费已提交但响应丢失，或后续 Auth 失败，原挑战保持不可重用。挑战解析补充 nonce 格式、时间类型和未来时钟偏差检查。
- 新增独立迁移 `0037_wallet_nonce_consumption.sql`：唯一键原子插入，额外限制数据库接收的签发时间，账本启用 RLS，禁止 anon/authenticated/service_role 直接访问，仅给 service_role 执行 `security definer` 函数；事务检查异常默认 ACL、表级/列级授权及角色继承，异常时整体回滚。账本至少保留 48 小时；只有后续成功消费才触发每次最多 64 条的惰性清理，不是定时删除。该迁移没有引用或改写 0031–0036，尚未在正式库执行。
- 应用隔离回归 16 个场景通过，包括原 cookie 顺序/并发重放、小写与校验和地址、附加后缀、错签、无效时间、RPC 错误/异常/异常返回、提交后响应丢失及后续 Auth 失败；独立身份流程 5 项通过。HTTP、cookie、Supabase、OTP 均为虚构存储，重放检查不代表真实 GoTrue。隔离 PGlite 12 组覆盖对象、RLS、角色、幂等、时间、清理及异常默认授权/列权限漂移；PGlite 不是多连接 PostgreSQL。受影响 lint 与无网络 Webpack 构建/TypeScript 通过，构建仍有原有 OG 图片提示。
- 独立 QA 在全新隔离 PostgreSQL 16.9 以最终 SQL SHA256 `55effd9c5c71eb9b2ec74b53b9e00fbb017e957dbc5aa13a66107973180d9f8f` 完成 8 组受影响复测：12 个独立连接竞争同一 key（含不同签发时间）仅一次成功，提交与回滚竞争安全；未知默认 ACL、继承 owner、以及 DDL event trigger 对 anon/authenticated/service_role 注入的单列授权均触发事务回滚。前一 SQL 版本另有 10 组多连接和 14 项真实路由对接隔离 PostgreSQL 的检查；最终版本仅补权限自检，受影响范围已重测。桥接使用虚构 cookie、身份和 OTP，未经过真实 PostgREST 或 GoTrue。
- 新增只读预检、后检及部署回退说明：`docs/operations/2026-11-12-wallet-nonce-preflight.sql`、`2026-11-12-wallet-nonce-postflight.sql`、`2026-11-12-wallet-nonce-deploy.md`。生产目标、角色与默认 ACL、迁移历史、函数定义、表/列权限、触发器、PostgREST schema cache 和两种迁移顺序仍须按说明核验；不能通过 CLI 把未执行的 0031–0036 伪标为已应用。应用先于数据库部署会安全失败并导致钱包登录不可用。
- 仅对旧 `50b83de` 与当前 `67da8fe` 的两个不可变生产地址做匿名 HEAD：登录页及钱包 verify 路径均重定向至 Vercel SSO；其他别名、请求方法、授权访问和旧部署凭证是否仍有效未验证，不能据此排除旧写入路径。验证请求发出后关页/取消与不同挑战间的服务端会话竞态、真实钱包/手机、真实 Supabase 和安全回退仍待验收；Zod 3 的 11 个 high 审计传播节点未改变。PR #48 继续草稿，不能合并或声称正式修复。
- 本批实现由当前聊天执行，沿用用户所述界面选择 Terra Max；本轮接口未返回主会话可见的具体运行型号或强度，不据自述推断内部路由。独立 QA 复用既有 `zod_security_review` 子 agent；没有修改个人全局模型配置，也未调用设计渠道。

## 2026-11-12 nonce 迁移顺序隔离检查

- 使用完整的候选 SQL，在临时 PostgreSQL 16.9 中从同一套 0001–0030 基线分别验证三条顺序：0037 在 0031 之前、在 0031 之后且 0032 之前、在 0036 之后；业务迁移始终依序执行 0031 → 0032 → 0033 → 0034 → 0035 → 0036，每个文件保留原事务。候选 0031–0037 的 SHA256 分别为 `6bce34b659d42c436bb1d5f6cf5ced66492b5c1a3d6f1af76788b2222cde8a4e`、`a80ce961b9692011c0bac1edef2a665296287b7c98688597fc720bc916ed1af7`、`4f49f3d75286725412436d2d037aa31178f9db4f7b8fa0ac66664e9653e91e9d`、`6ab80a49887bed5ed7a98c3fd6e9df4653751363f995aa22d4c4d9f0ad954bf1`、`7badb8846a3379fd881a745d59f82a5ae174f9075c3edea1f9f0b2a73660d9ba`、`ac6c0699359776ab5004ec370faa8b7bc3cecbd1ab2dddb5c316b469140e2a8e`、`55effd9c5c71eb9b2ec74b53b9e00fbb017e957dbc5aa13a66107973180d9f8f`。
- 三条顺序均通过：预先消费的虚构 nonce 在后续业务迁移后仍不能重放；选定的历史反馈、投稿和队列租约保持不变。0037 后置时，逐行比较 17 张业务表和两张模拟 Storage 表的数据，涵盖虚构签到、经验、通知、奖品库存及媒体暂存样例；三个最终数据库的公共关系元数据、函数定义与 owner/ACL、列 ACL、索引及触发器定义一致。另检查消费函数和账本的角色限制、论坛反馈入队、投稿审核、黑名单签到拒绝、媒体暂存归属、模拟 Storage 策略、媒体关联及审核。这里的历史与账号均为隔离夹具，不代表生产历史数据已核验。
- 四种错误顺序均按原迁移约束失败并回滚，已消费 nonce 保留：缺 0031 执行 0032、缺 0032/0033 执行 0034、缺 0035 执行 0036、0035 先于 0034。最后一种失败源于 0034 对既有 `SECURITY DEFINER` 标签写入路径的审查会拒绝 0035 新增的相关函数；继续执行原定 #45（0034）→ #47（0035/0036），不得调换并削弱此检查。
- 可复测脚本为 `tests/experiments/wallet-nonce-migration-order.mjs`，需要通过 `WALLET_QA_PG_BIN`、`WALLET_QA_PG_MODULE` 指定独立 PostgreSQL 16.9 与 `pg` 客户端，通过 `WALLET_QA_MIGRATION_0032` 至 `0036` 指向对应既有分支的准确 SQL。测试自行创建并关闭临时数据库，只监听随机回环端口；每次连接先核对数据库目录、postmaster PID 与所启动进程，避免端口被其他实例占用时误执行。项目 Node 22.23.3 在系统规则阻止非回环网络下运行，专项 lint 通过。角色、`auth`、Storage、认证状态与历史数据均为模拟；系统规则仍允许本机其他回环端口，不限制本机文件访问。
- 全表迁移前后对比仅发生在 0037 后置场景；0037 前置场景对既有业务数据主要检查选定的反馈、投稿与队列租约，不能据此断言全部历史均被后续业务迁移保留。三个数据库的目录对比未完整包含列类型、默认值、CHECK、FORCE RLS、RLS policy 或 Storage schema；相同结果也无法排除三种顺序共有的问题。并发消费、角色继承、异常默认 ACL 和过期清理由前述专项测试覆盖，不属于本轮顺序测试。
- 独立 QA 在自身临时目录复跑最终脚本，三条完整顺序和四种错误顺序均通过；最终脚本 SHA256 为 `560943ac7733ccfccda2e83cda6320bb7c1413c1e03a70a256828c2b990ebf69`。对连接身份的负控返回错误目录时立即退出，记录中只执行 `show data_directory`，没有创建角色或数据库、没有执行迁移。此前对同功能旧版脚本的三个独立 SQL 负控分别使重复消费、历史反馈改写和 anon 获得执行权被断言拒绝；最终脚本仅增加连接身份检查。独立复测的系统规则下非回环 TCP 返回 `EPERM`，各轮只清理各自新建的数据目录。证据位于 `/private/tmp/imtoken-order-independent-qa.pBPIQn` 与 `/private/tmp/imtoken-order-identity-qa.W5nAGl`。
- 这项检查不验证正式库的迁移台账、执行角色/default ACL、实际 Supabase Storage/RLS、PostgREST schema cache、旧部署绕过或真实钱包。当前钱包依赖仍有 11 个 high 审计传播节点，PR #48 继续为草稿，不得合并或称线上修复。业务回退也不能覆盖 0036 的反馈包装函数或恢复旧钱包验证实现；正式预检和回退方案仍须逐项核验。
- 本批由当前聊天执行，沿用用户所述界面选择 Terra Max；本轮接口没有返回主会话可见的具体运行型号或强度。独立 QA 复用既有 `zod_security_review` 子 agent，没有修改全局模型配置或调用设计渠道。

## 2026-11-13 钱包替代方案的尝试隔离实验

- 继续使用项目外独立安装的真实 UniversalProvider / SignClient 2.26.0、本机模拟 relay 和临时虚构签名账号，未替换项目的 EthereumProvider、扫码界面或依赖锁文件。两次尝试使用不同 `customStoragePrefix` 却共用同一个内存 Storage 时，旧尝试取消后仍获批准；显式断开旧会话会删除新会话的 UniversalProvider 持久化键。新会话仍存在于双方 SignClient 中，原内存实例在清理前后均可签名；使用同一 SignClient 和 session 重建 Provider 时，namespace 选项丢失，本实验中的 `personal_sign` 失败。该重建不是实际浏览器重启或真实钱包测试。
- 两次尝试分别使用独立内存 Storage 且使用不同 prefix 时，同一模拟条件下旧清理未删除新 Provider 的键，新会话仍可在清理前后签名，使用同一 SignClient 重建后也可完成临时签名。这只覆盖所测会话和签名，不证明 IndexedDB、跨标签、手机、取消、网络中断或所有 SDK 功能隔离。另用真实 SDK 证明相同 prefix 即使传入不同 Storage，默认全局 Core 仍复用第一次的 Core 和 Storage。
- 独立源码审查发现 `cleanupStorage` 在自身 session 数为零时按 UniversalProvider 固定前缀清理整个底层 Storage，而不是按尝试 prefix 清理；SDK 还有模块级 client/event 和部分 EIP-5792 状态的 Storage 缓存。因此仅设置不同 prefix 或仅传不同 Storage 均不足以声称完整隔离；后续接入必须同时处理独立 Core、隔离 Storage 视图及模块级状态，另行验证晚到会话与 pairing 清理。
- 实验早期曾在临时签名等待中超时，独立排查确认 SDK 的 `approval.acknowledged()` 返回 session 并不等待 wallet 侧 `acknowledged` 标志真正变为 true。脚本现等待实际标志再签名；修订后项目 Node 22.23.3、禁止非回环网络下三次连续通过，专项 lint 通过；未证明这已消除先前超时的全部原因。独立负控还确认未完成的 SDK proposal/request 定时器可在失败后继续保活进程，因此新增独立父进程 runner：成功须唯一通过报告且子进程自然退出 0；失败后超过清理期限或总超时时只终止自身子进程并保持失败，不能将其视为 SDK session 已清理。
- 独立 QA 复跑最终脚本，实际 worker 自然退出 0；12 组主控及一组 SIGKILL 兜底控制符合预期。共享 Storage 人为恢复被删键、独立 Storage 人为删除新键均触发断言失败；抑制签名响应、失败后挂起、虚假成功后挂起、重复成功/未知状态、无结果 exit 0 和相互矛盾的结果均未被 runner 误报为成功。忽略 SIGTERM 的虚构 worker 由 runner 终止且保持失败；未称其 SDK session 已清理。最终 worker SHA256 `e937d3d67391ac2e670fac5a3e04f62cfbf1fae2dd4f06005a596ba9abb48a5a`，runner SHA256 `62f437d8495be26e44877298e1e29152b1a9d72ba1fafee61e01417a1066c81f`，独立证据在 `/private/tmp/imtoken-wc-runner-independent-qa.GOzXLY`。
- 模拟 relay 不代表实际服务，14 次 SDK Verify fetch 被拦截；系统规则允许其他回环端口且不限制文件访问。未验证真实钱包/手机、二维码隐私、屏幕阅读器、跨标签、旧尝试的 nonce/verify/跳转隔离、服务器会话竞态或 pairing 全量清理。现有钱包 Zod 3 的 11 个 high 审计传播节点没有减少，PR #48 仍为草稿，不能合并或称正式修复。
- 本批由当前聊天执行，沿用用户所述界面选择 Terra Max；本轮接口没有返回主会话可见的具体运行型号或强度。独立 QA 复用既有 `zod_security_review` 子 agent，没有修改个人全局模型配置或调用设计渠道。

## 2026-11-13 钱包尝试隔离 Storage 候选

- 新增尚未接入登录流程的 `src/lib/walletconnect-scoped-storage.ts`，为共享异步键值后端提供按尝试隔离的 SDK 视图。scope 使用 Web Crypto 生成 16 个随机字节，随机源不可用时失败；逻辑键按 UTF-16 编码为稳定物理键，避免底层 unstorage 对斜杠、反斜杠、冒号、问号及空键的规范化碰撞。各视图只返回自身逻辑键；`getEntries` 先筛选键再逐项读取自身值，跳过 undefined，结果不是原子快照。底层 `getKeys` 仍枚举整个后端，不是同源代码间的权限或保密边界。
- 视图内操作按顺序执行；`close()` 开始即标记退役，等待已开始的后端操作后仅清理自身键，清理失败明确返回错误且可重试。退役后 SDK 的晚到读取为空、写入和删除为空操作，以免 SDK 的后台调用产生未处理拒绝或重建旧数据；已开始的读取若在退役后返回也不会交回旧值。`closed` 只表示已退役，不表示清理成功或 SDK 已停止；未来调用方必须独立验证尝试归属，并在 nonce、签名、verify 和跳转前拒绝旧结果。重复使用同一 scope、另一个视图或其他同源代码可绕过此视图的生命周期，不能把它当安全授权。
- 12 项隔离单元检查覆盖随机源失败、scope/逻辑键注入、隔离枚举和清理、真实 WalletConnect Node 内存后端的键规范化往返、损坏键、在途读写和清理失败重试；真实 UniversalProvider/SignClient 2.26.0 经模拟 relay 的第 8 场景在同一虚构底层 Storage 上使用两个隔离视图及不同 SDK prefix，旧尝试断开与退役后，新会话的 Provider 键、签名及同客户端重建仍可用。该测试不证明完整 SDK 模块级缓存或真实浏览器重启安全。专项 lint 与 TypeScript 检查通过。
- 独立 QA 复跑 12 项单元和真实 SDK 的 8 个隔离场景均通过；取消枚举过滤、跨 scope 删除、编码碰撞、不等待在途写及吞掉清理异常五个源码负控均被检出。实现文件 SHA256 `9066a7a5486e3d16867b98eea2b200bb304a84257f46487e017fe48bbbc42132`，单元脚本 `b0e4f73b2c890082606ea317e4196ade67b1e485a87136d50fdfac580cdef569`，协议脚本 `5a919f5f95832f08cb609372550cc7b891a02d9389bfa3126a5a7a2edb6f8736`；独立证据在 `/private/tmp/imtoken-scoped-storage-independent-qa.VerSj6`。验证源码与最终源码仅差安全说明注释。
- 此候选尚未替换现有项目钱包 SDK、界面或锁文件，也未接入真实登录；不改变 11 个 high 审计传播节点。持久化后端会保存敏感会话材料，随机 scope 不加密；重启恢复、孤儿 scope 回收、跨标签并发、SDK 全局 Core/模块缓存、晚到会话与 pairing 清理、手机和真实钱包仍待设计与验收。PR #48 保持草稿，不能合并或称线上修复。
- 本批由当前聊天执行，沿用用户所述界面选择 Terra Max；本轮接口没有返回主会话可见的具体运行型号或强度。独立 QA 复用既有 `zod_security_review` 子 agent，没有修改个人全局模型配置或调用设计渠道。

## 2026-11-13 钱包登录合作式取消屏障候选

- 两种钱包登录函数增加可选的尝试生命周期检查；未传参数时保留原调用方式。未来调用方可传入 `AbortSignal` 和同步、只对当前尝试有效的 `isActive` 检查；该检查必须在尝试退役后持续为 false。入口、取得锁后、钱包初始化和连接后、nonce 响应与解析后、签名后、verify 响应与解析后以及清理完成后都检查当前尝试；拒绝或异常的生命周期状态统一返回可识别的 `WalletSignInCancelled`。异步回调不被接受，其拒绝被处理；回调同步中止或替换 signal 也会失败关闭。普通钱包错误在尝试仍有效时保持原样。
- 不用 `Promise.race` 提前结束旧流程：请求、钱包操作或清理在途时继续持有现有锁，初始化晚到后仍进入该 provider 的清理路径，晚到连接不会继续获取 nonce。这样可能一直等待无响应的钱包；没有保证 SDK 完全停止、pairing 删除或断开成功。已发出的 nonce 可能已设置 cookie，已发出的 verify 仍可能在服务端消费挑战并写入会话，取消不代表撤销这些副作用。
- 这一接口**尚未接入登录页或新增取消控件**，现有页面没有传入生命周期参数；当前用户仍不能据此取消登录。页面除钱包回调设置 `window.location.href` 外，还会在已有用户状态出现时通过 effect 调用 `router.replace`。未来接入必须分别处理两条导航路径、旧尝试迟到的 UI 状态更新、provider 清理、活动会话与跨标签，并在实际导航前同步复查尝试归属；不能只依赖 Storage 退役或单个跳转检查。
- 项目 Node 22.23.3 和系统禁网下的 19 项新隔离测试覆盖两种钱包、锁回调、初始化/连接晚到、nonce/响应体、签名、verify 和断开中的取消；测试明确模拟 verify 已发出后服务端仍发生写入。先前同批源码 SHA256 `21be25f887193a8db4ef434beec602d4a3119d4f258e566fb053e795c4499a8b` 的授权/锁回归 26 项和真实客户端、临时签名/HMAC 与虚构 HTTP/cookie/OTP 的 5 项身份断言通过；独立 QA 在中间源码 SHA256 `1c7f6df722374418ff8408a1fd3e2bfee1d1f017ab8105f0984f0bf19e6dd711` 另复测身份流程通过，最终两次修正仅影响传入生命周期参数的检查。专项 lint 与最终源码的无网络 Webpack 构建和 TypeScript 通过，构建保留既有 OG `maxWidth: none` 提示。隔离夹具不代表真实浏览器、钱包、Supabase、OTP、手机、断连清理或服务端会话回滚。
- 独立 QA 发现初版异步 `isActive` 拒绝会产生未处理异常，及同步回调中止 signal 后仍会放行；均已修复，独立复测两个探针和最终 19 项均通过。独立反例移除签名后屏障、断开等待、初始化后屏障时分别检出错误。最终 `wallet-client.ts` SHA256 `2d215023c75b184eacd619113f0205fa011588494b56be9332778940da6d23b7`，单元测试 SHA256 `c9d4bcde11227cc6633731836c03082841884a5686525d0831dd523fa6f22c62`；独立证据位于 `/private/tmp/imtoken-wallet-cancel-independent-qa.2vvIqH`。
- 本批由当前聊天执行，沿用用户所述界面选择 Terra Max；本轮接口未返回主会话可见的具体运行型号或强度。独立 QA 复用既有 `zod_security_review` 子 agent，没有修改个人全局模型配置或调用设计渠道。项目钱包 SDK、扫码界面和依赖锁文件未替换，11 个 high 审计传播节点、0037 正式库预检与迁移、旧部署路径和回退仍未解决；PR #48 保持草稿，不能合并或称线上修复。

## 2026-11-13 钱包浏览器存储迁移竞态与独立后端候选

- 独立安全审查发现，现有 `@walletconnect/keyvaluestorage@1.1.1` 的浏览器初始化会在默认数据库外读取并清理旧 localStorage 键。以全新隔离 WebKit profile、两个同源标签、虚构 session 及真实 SDK 键 `wc@2:client:0.3//session` 测试：当两个初始化都进入旧数据迁移、第二个持有旧键列表且第一个已复制并删除原键时，第二个可能将缺失源值写回 IndexedDB，覆盖先前复制的 session。独立 QA 在原生 IndexedDB 记录中观察归一化键 `wc@2:client:0.3:session` 从完整虚构数组变成空字符串，旧 localStorage 键已经删除。测试用人为延迟枚举结果强制时序，没有修改 SDK 包源码；不代表已在线上发生，也不确定真实发生频率。主线锁文件含相同的 1.1.1 版本，并经现有 EthereumProvider 依赖链使用；尚未访问或核验用户浏览器数据。
- 保留安全断言的基线脚本 `tests/experiments/walletconnect-browser-storage.mjs` 在该强制时序下退出 1，不能把它记作通过。独立脚本与原生记录证据在 `/private/tmp/imtoken-wc-migration-independent-qa.qW7c8a`。另以人为注入的异步 IndexedDB open 失败观察默认 SDK 初始化未完成、读取和退役清理持续等待，并出现未处理拒绝；这是失败注入，不代表浏览器一般都会失败。
- 新增尚未接入钱包 SDK 或登录页的 `src/lib/walletconnect-indexeddb-storage.ts` 候选：使用单独的 IndexedDB 数据库，不读取、迁移或删除旧 SDK 的数据库及 localStorage；与既有 scope 视图组合供未来尝试使用。操作等事务完成，事务 abort 和打开失败明确报错；失败后关闭视图仍可重试清理，失效连接允许后续重新打开。被阻塞的 open 已拒绝后，晚到升级被中止、晚到连接被关闭。该方案不修复正在使用的旧 SDK 迁移，也不会自动恢复其旧会话；若未来切换后需要重新配对，须按真实钱包体验验收。
- 真实 WebKit、临时持久化 profile、拦截的虚构页面与系统禁止非回环网络下，14 组隔离检查通过：跨同源标签的不同 scope、特殊键、null/缺失值、写入/删除事务失败、延迟写后清理、旧 localStorage 保留、关闭并重启浏览器后的持久化、同 scope 重用、异步 open 故障、阻塞请求的晚到回调和版本变更。延迟写检查在实际后端调用前人为挂起，不等同于验证所有原生事务时序；同 scope 的另一个视图不会继承退役状态，未关闭 scope 会残留。页面/账号/数据均为虚构，不代表真实钱包或移动设备。
- 独立 QA 对最终实现和 14 组脚本复测通过；初版发现的入队后同步异常未中止事务、null 被当作缺失、失效连接不能重开三项均已修复并以探针复测。删除旧 localStorage、把事务 abort 当成功、禁止失效连接清理三个独立负控均被检出。最终实现 SHA256 `ca706364193aa4e8b6b4d6811f318474c84c14cc7840529734596539b0ee6b3b`，候选浏览器脚本 SHA256 `7c12a1d697d3b6502d0936de4bcb375db184cafa70967ac433f0a5bf3b91883e`，默认 SDK 基线脚本 SHA256 `e32da5ae3e527478c51f2f98d251e6cdb0781b8602b929cc8f163415f310d30a`；证据见 `/private/tmp/imtoken-indexeddb-independent-qa.AgCWjw`。专项 lint 和 TypeScript 通过。
- 候选使用 IndexedDB structured clone，默认 SDK 使用自身 JSON 序列化；独立 WebKit 对照 22 种输入，仅普通文本、前导零字符串和一份虚构 JSON session 形状的返回值相同。其余 19 种有差异，包括 null、undefined、BigInt、Date、数值样式字符串、typed array、函数和循环对象；这些差异本身不证明实际 SDK 会失败，但不能把候选称为完全兼容。对照证据在 `/private/tmp/imtoken-indexeddb-independent-qa.AgCWjw/serialization-comparison.json`。尚未以真实 UniversalProvider/SignClient 连接此浏览器后端，SDK 模块级状态、同 scope 多实例、孤儿数据回收、实际二维码/手机及服务端会话竞态均待验收。现有 SDK、扫码 UI 和依赖锁文件未改变；11 个 high 审计传播节点及 0037 正式预检/迁移仍未完成，[PR #48](https://github.com/simonliuliu/imtoken.fans/pull/48) 保持草稿，不能合并或称线上修复。
- 本批由当前聊天执行，沿用用户所述界面选择 Terra Max；本轮接口没有返回主会话可见的具体运行型号或强度。独立 QA 复用既有 `zod_security_review` 子 agent，没有修改个人全局模型配置或调用设计渠道。

## 2026-11-13 钱包浏览器协议与持久化隔离实验

- 在项目外隔离依赖目录使用真实 UniversalProvider、SignClient、Core、utils 和 types 2.26.0；浏览器 fixture 的 Webpack 构建检查每个 `@walletconnect` 模块来自隔离目录，并读取上述五类实际模块最近的 package.json 校验版本，防止混入项目当前的 2.24 依赖。项目 SDK、钱包界面和锁文件没有替换。测试显式关闭 SDK 全局 Core 复用并为每次尝试使用不同 prefix，不证明默认 Core 或其他模块级缓存安全。
- 隔离 WebKit 的虚构页面使用现有 scope 视图与未接入业务的独立 IndexedDB 后端，实际连接本机虚构 relay 和 Node 端真实 SignClient/临时随机签名账号。测试确认 provider 的 Core 实际使用传入的存储，原生 IndexedDB 含对应 scope 的记录；完成临时账号签名及验签后，另一标签用不同 scope 启动无会话的 provider 并清理自身存储，首个 provider 仍可签名。虚构的旧 SDK localStorage 会话键在此流程中保持不变。
- 关闭整个隔离浏览器上下文后，用同一个临时持久化 profile 启动新的 WebKit 进程与页面；相同 scope 和 prefix 的 provider 从实际 IndexedDB 恢复所测 session，并再次通过临时账号签名验签和现有会话权限检查。随后显式断开，虚构钱包收到 session 删除事件，当前 scope 的原生 IndexedDB 键清理完成。这只覆盖本次 session 的恢复和清理，不代表 pairing 记录、所有 SDK 后台状态、真实浏览器崩溃恢复或其他设备已验收。
- 运行方式：设置 `PLAYWRIGHT_BROWSERS_PATH=/private/tmp/imtoken-playwright-1.64.1` 和 `WALLETCONNECT_TEST_DEPS_ROOT=/private/tmp/imtoken-wallet-probe.a70IT3`，在项目根目录用 `sandbox-exec -p '(version 1) (allow default) (deny network*) (allow network-inbound (local ip "localhost:*")) (allow network-outbound (remote ip "localhost:*"))' ./node_modules/node/bin/node tests/experiments/walletconnect-browser-protocol-runner.mjs`。父进程只管理自身 worker，只有唯一成功报告且子进程自然退出 0 才算成功，失败或超时强制终止仍是失败。测试浏览器页面请求被拦截，JS 限定 WebSocket 目标为本次 relay 并阻止 fetch/XHR/Beacon；系统规则禁止非回环网络但允许其他本机回环端口，且不限制文件系统。Node 侧 4 次外部网络尝试被拦截；浏览器路由另拦截 4 次 `verify.walletconnect.org` 请求，页面 JS 的 fetch/WebSocket/XHR/Beacon 拦截计数和已观测未处理错误为 0。实时事件上报及 Playwright 页面错误检查覆盖页面生命周期；不据此推断真实 SDK 的联网、遥测或隐私行为。
- 项目 Node 22.23.3、上述网络限制下完整脚本自然退出 0，三次临时签名均验真，专项 lint 通过。该实验没有使用真实钱包、手机号、二维码、实际 relay、真实账号或 Supabase；此前 22 种存储值比较中 19 种差异没有因一份真实 SDK session 流程通过而消失。旧 SDK 迁移安全基线仍按预期保留失败断言，11 个 high 审计传播节点、0037 正式预检/迁移、旧部署和回退未解决；PR #48 继续草稿，不能合并或称线上修复。
- 独立 QA 复跑最终脚本自然退出 0；混入项目旧 SDK、错误签名、错误恢复 scope、浏览器后台同步异常、最后采样后的 Promise 拒绝和成功标记后的 Promise 拒绝六项协议负控均退出 1。QA 发现初版只在页面关闭前取一次未处理错误快照，可能漏掉迟到拒绝；已改为页面生命周期内实时上报、保留 Playwright `pageerror` 并在清理后复查，两个迟到拒绝负控均被检出。runner 的唯一正常成功、虚假成功挂起、失败挂起、SIGKILL 兜底、重复或未知结果、非零退出等 9 项独立控制符合预期。最终 worker SHA256 `e40537311e4f810e27d9c4bcb068ea06132a62d57ef7017e1466ff0baad6dfc9`，runner SHA256 `d358c715888c898f422148805043fdf374011dd4405255e8137db7376db62f12`；证据在 `/private/tmp/imtoken-browser-protocol-independent-qa.zdV5Hr`。
- 本批由当前聊天执行，沿用用户所述界面选择 Terra Max；本轮接口未返回主会话可见的具体运行型号或强度。独立 QA 复用既有 `zod_security_review` 子 agent，没有修改个人全局模型配置或调用设计渠道。

## 2026-11-13 钱包登录页生命周期接入候选

- 两种现有钱包入口现在各自传入唯一尝试归属；组件卸载或收到 `pagehide` 时同步退役旧归属，已在途的钱包连接、nonce、签名、verify 和断开仍由原客户端等待完成，并在既有异步边界重新检查。成功后立即在整页跳转前复查归属；旧尝试的失败不会修改新页面或新尝试的提示。重复点击在页面内立即拒绝。返回 `pageshow` 后恢复控件，没有新增可见取消按钮或改变 SDK、扫码界面和文案。
- 用户状态的自动 `router.replace` 在同一页面模块内等待全部钱包尝试完成，模块级集合在组件卸载和同模块重挂后仍保留在途状态；每个尝试仅在自身 `finally` 中移除。独立 QA 在初版发现：`pageshow` 过早清除等待状态时，用户已认证而旧 WalletConnect 断开仍挂起，可提前自动跳转；最终实现按实际在途集合等待，第二次尝试被锁拒绝也不会清除旧尝试的等待状态。原有浏览器锁仍负责钱包互斥，页面集合不替代该锁。
- 项目 Node 22.23.3、系统禁止网络及临时 WebKit 下，真实登录页与真实 wallet-client 配合虚构 provider、会话、HTTP 和 Action 的 `tests/browser/wallet-sign-in-page.mjs` 通过 19 场景，包含两种入口的成功、卸载及晚到结果、模拟 pagehide/pageshow、断开期间已有用户、同模块重挂、被锁拒绝的重试、密码/Google 路径和已发 verify 的模拟写入。钱包客户端取消边界隔离回归 19 项通过。另在禁止非回环网络、本机虚构认证 API 的 Next 开发页以 WebKit 完成中英桌面/窄屏、密码、Google、导航及校验 9 项；测试账号和数据均为虚构。旧认证夹具仍产生先前记录的缺少模拟帖子分类提示，不能据此推断真实内容问题。
- 独立 QA 复跑最终页面及浏览器脚本 19/19，并在临时副本验证 3 项负控：移除自动跳转屏障、错误清空其他在途尝试、卸载后保留旧归属均触发测试失败。独立证据在 `/private/tmp/imtoken-wallet-page-final-qa.1d11gwxm`。最终页面 SHA256 `c294a582c5dfbc929ba7458412dc318fd7b5c75604eae965f38794aca3f48011`，浏览器脚本 SHA256 `d6396445feb979cae9ae1b34ad19c25e1b74cd49d596da5dd5ab01de49b5f624`；QA 所测 wallet-client SHA256 `2d215023c75b184eacd619113f0205fa011588494b56be9332778940da6d23b7`，之后只更新其接口说明注释，最终 SHA256 `c9aeb83072aab7bd02232ae9ef20ca8a8dea33020217e9b500bfef61b5c9344c`。中英 1,572 键检查、完整 lint 及最终页面的受影响 lint、无网络 Webpack 构建与其 TypeScript 检查通过；构建保留既有 OG `maxWidth: none` 提示。
- 测试以人为事件模拟 pagehide/pageshow，未验真实 BFCache；页面集合仅限同一 JavaScript 模块实例，不覆盖新文档、其他标签、旧 bundle 或其他浏览器。verify 已发出后仍可能写入服务器会话，退役和停止主动跳转不能撤销该副作用；断开失败或挂起、SDK 后台停止、真实钱包/手机/二维码及真实 Supabase 仍未验收。默认 SDK 双标签旧存储迁移的安全基线仍失败，两个 Zod 3 导致的 11 个 high 审计传播节点仍未解决，0037 正式预检/迁移、旧部署入口与安全回退仍待核验；PR #48 保持草稿，不是线上修复。
- 本批由当前聊天执行，沿用用户所述界面选择 Terra Max；本轮接口未返回主会话可见的具体运行型号或强度。独立 QA 复用既有 `zod_security_review` 子 agent，没有修改个人全局模型配置或调用设计渠道。

## 2026-11-13 钱包浏览器存储值编码候选

- 为独立 IndexedDB 后端和 scope 视图增加尚未接入登录的值编码层 `src/lib/walletconnect-storage-codec.ts`，复用当前锁定的 `@walletconnect/safe-json@1.0.2` 与 `destr@2.0.5`，分别作为明确的直接依赖。两者原本已在生产依赖树中，锁文件仅增加根依赖声明，没有更换已有包版本。该层按默认 SDK 1.1.1 浏览器 IndexedDB 分支分别处理写入、单项读取和条目枚举；枚举保留 null/undefined，单项读取将 null 当作缺失，枚举仍是非原子快照。
- 编码值使用独立版本化逻辑命名空间，不能覆盖或误读同一 scope 内早先的原始 structured-clone 值；scope 保留无损键编码，不复制默认后端将斜线和冒号归一化为同一键的行为，这是有意的键语义差异。未来调用方必须为编码格式使用全新随机 scope：关闭一个 scope 会清理该 scope 下全部键，不能用它迁移或保留复用 scope 中的旧格式记录。现有用户的 SDK localStorage 和数据库没有迁移或删除。
- 在真实默认 SDK 1.1.1 浏览器 IndexedDB 后端与候选编码层之间，用隔离 WebKit profile 对照 31 种虚构输入的写入/单项读取结果及 29 条枚举结果，覆盖 null、字面量 `undefined`、BigInt、Date、数值/布尔/JSON 字符串、原型字段、typed array、函数、循环值和抛错的 `toJSON`；并检查枚举期间删除、原始格式不被覆盖、不同逻辑键不碰撞及退役后无副作用。正常状态下序列化或后端错误继续传播；SDK 晚到调用在退役后不再序列化，`toJSON` 同步退役后再抛错也不会生成未处理拒绝。
- 真实 UniversalProvider/SignClient 2.26.0 的隔离 WebKit 协议实验接入该编码层后，临时账号三次签名验真、未连接的第二 scope 清理、浏览器重启后 session 恢复及显式断开仍通过；浏览器 4 次 Verify 请求和 Node 侧 4 次外部网络尝试被拦截。测试显式禁用 SDK 全局 Core，钱包、relay、profile、账号和数据均为虚构；没有验证两个已批准的浏览器会话、实际二维码/手机、真实服务或业务 nonce/verify。Webpack 允许编码层使用项目直接依赖的 safe-json，同时检查其与隔离 SDK 副本的浏览器模块逐字节一致，并检查 SDK 核心五类包实际来自隔离目录及其 2.26.0 版本。
- 新鲜临时目录的 `npm ci`、中英 1,572 键、完整 lint 和无网络 Webpack 构建/TypeScript 通过；完整构建后根据独立 QA 修复了尚未被应用引用的编码层退役异常，再针对最终修改复测受影响 lint、TypeScript、值对照和真实 SDK 协议。完整及生产依赖 audit 均仍为 0 critical、11 high、0 moderate，退出码 1；这是既有钱包依赖链告警，不能合并或宣称安全检查全部完成。
- 独立 QA 发现初版在 `toJSON` 同步退役后抛错时仍返回拒绝，可能导致 SDK 后台未处理拒绝；修复后独立探针通过。最终源码的 31 种值/29 条枚举、真实 2.26.0 协议及跨 scope/并发删除复测通过；去编码、丢 null/undefined、去值命名空间覆盖原始格式、恢复退役后拒绝四项源码负控均被检出。四个负控使用最终编码层及前一测试脚本 SHA256 `9924fb732cfebc73b277200d4c42687760d9a60bb101d7414491ecc5950dec18`；最终脚本只增加活跃后端写失败对照，该项另独立复测通过。最终编码层 SHA256 `54e1f1dd07b2790dbc07d5087b6f6878db9d34b97227aae8c08b43e7b54b4203`，值对照脚本 SHA256 `37d4f63f35901fe3aa586d74fa12a3dcb1f18ac0d874a9913f3859f9ff56960c`，协议脚本 SHA256 `309ddf4a54f53f93fb1ede35fcfb555f8783f56a24993cf6d96bb78131f1d7c4`；独立证据在 `/private/tmp/imtoken-codec-independent-qa.l6QdLc`。
- 这些有限对照不代表所有值、其他浏览器或真实 SDK 全部方法兼容；默认 SDK 旧数据迁移基线仍失败，原 SDK 本身尚未被修复。SDK 替换及真实钱包/手机、旧会话接续、孤儿 scope 回收、全局 Core、服务端会话竞态、0037 正式预检/迁移和安全回退仍未完成。项目现有 SDK 与 UI 未替换，PR #48 保持草稿，不能称线上修复。
- 本批由当前聊天执行，沿用用户所述界面选择 Terra Max；本轮接口未返回主会话可见的具体运行型号或强度。独立 QA 复用既有 `zod_security_review` 子 agent，没有修改个人全局模型配置或调用设计渠道。

## 2026-11-13 旧钱包跳转风险与一次性内存存储候选

- 独立 QA 在项目现有 `@walletconnect/ethereum-provider@2.24.0` 的真实浏览器 SDK 中发现：若 `WALLETCONNECT_DEEPLINK_CHOICE` 在签名时仍包含先前钱包的有效链接，文档有焦点且该 session 未禁用 deeplink，`personal_sign` 路径可能直接读取该旧值并打开它，在 URL 中附带本次 `sessionTopic` 和 `requestId`。这是旧钱包导航和会话标识暴露风险，不是已证实的认证绕过；topic 不包含会话解密密钥，测试未观察签名或私钥随 URL 外发。该 SDK 默认行为能用于同设备钱包切换，关闭它对手机体验有影响。
- QA 在隔离 WebKit、本机虚构 relay、临时签名账号、默认 SDK 存储及 `showQrModal=false` 下完成五组对照并验真 5 次签名：旧值/有焦点读 1 次并调用拦截的 `window.open`；无值读 1 次但不打开；旧值/强制无焦点读 1 次但不打开；钱包批准 `disableDeepLink=true` 时不读不打开；显式 false 时读 1 次并打开。又以运行时 `instanceof` 确认实际 SignClient 与 Core 均来自项目 2.24.0，并完成第 6 次虚构签名。Webpack 完整静态依赖中另有 2.23.7 的 UI 相关闭包，未强制改写或把它称为活跃实例。旧 choice 是连接后人为植入的虚构值，导航被拦截且旧键未删；未确认项目实际扫码弹窗是否会覆盖该值、真实钱包/手机或线上是否发生。独立脚本及说明在 `/private/tmp/imtoken-ephemeral-independent-qa.x2q7utj0/deeplink-probe`，五组 worker SHA256 `2f094a4f14467ee82bc51ad34da9597bea60f06d70249938786997de2e549846`，运行时身份 worker `4518ca7703e02a43d312a6c3de93712e91d06765fba352c69bf6ce2a724a3419`。
- 新增尚未接入业务的 `src/lib/walletconnect-ephemeral-storage.ts`，为一次尝试提供独立内存 Map，关闭立即清空本 Map 并令后续调用为空操作；不访问 IndexedDB 或 localStorage，也不自动恢复页面销毁后的 session。原始 Map 保留对象引用，且关闭无法撤销此前已返回的值或清除 SDK 的其他副本；实验在 SDK 外包裹既有值 codec，限定场景下避免引用别名。用户旧 SDK 数据没有被迁移或删除，不能认为 SDK 其他部分也不读取这些数据。
- 隔离 WebKit 用真实默认 SDK 浏览器后端对照内存+codec 与既有 IndexedDB+codec，31 种虚构输入、29 条枚举以及对象读写后的突变隔离相符；8 项内存隔离/退役单元通过。真实 UniversalProvider/SignClient/Core 2.26.0 经虚构本机 relay 完成独立内存 codec 的临时签名、显式 Core 引用核验、关闭与新尝试不恢复旧 session；同一脚本还保留既有 IndexedDB 重启恢复及三次签名。没有使用真实钱包、真实 relay、真实账号或手机。
- 2.26 内存方案默认 session 在签名时也会直接读取浏览器旧 choice，因而 `tests/experiments/walletconnect-browser-protocol-runner.mjs` 默认保留零旧存储读取和零旧地址打开断言并退出 1；模拟旧地址和导航均被拦截。这项失败不能记为通过。钱包主动批准 `disableDeepLink=true` 的限定正例零读取/零打开；另在钱包未提供该配置时，以公开 Session Store API 对本地 session 设置该字段的实验，在所测一次 session 更新后保留其余字段、零读取/零打开并完成签名。后者不是钱包协商结果或已采用的产品修复：Store 引用、后续会话变化/并发、失败时序、其他 SDK 版本及手机打开钱包体验仍须验证；不能以这两个正例代表所有钱包或放宽默认失败断言。
- 独立 2.26 Core 资源探针还观察到：构造时 Verify 已发起存储读取，关闭遥测时仍异步写空数组；构造后台读写抛错可产生未处理拒绝，不能只依赖 `start()` 捕获。同一 Core 并发 `start()` 可产生两个心跳，单次 `heartbeat.stop()` 仅停掉最后一个；初始化后段失败也可能留下心跳，默认全局 Core 按 prefix 复用并保留实例。替代实现仍须先拥有资源、单飞初始化、处理晚到结果和独立清理；`transportClose()`、`heartbeat.stop()` 或内存退役均不证明 SDK、pairing、远端 session 和全部密钥副本已停止或清除。独立隔离探针 `/private/tmp/imtoken-core-ownership-qa.zawypzt8` 使用 Node 22.23.3、系统禁网、虚构状态，未验证真实浏览器网络变化。
- 完整 lint、中英 1,572 键、无网络 Webpack 构建及 TypeScript 通过，构建保留既有 OG 图片提示。正式依赖仍是原 SDK，两个 Zod 3 的 11 个 high 审计传播节点、旧 SDK 存储迁移失败基线、旧钱包跳转默认失败检查、0037 正式预检/迁移、旧部署入口与安全回退均未解决；[PR #48](https://github.com/simonliuliu/imtoken.fans/pull/48) 继续草稿，不能合并或称线上修复。当前聊天沿用用户所述界面选择 Terra Max；本接口未返回主会话具体运行型号或强度。独立 QA 复用既有 `zod_security_review`，未改个人全局配置或调用设计渠道。
- 内存增量独立 QA 对最终源码复跑 8 项单元、31 种值/29 条枚举；默认零读取/零跳转检查如预期退出 1，失败后 runner 仅终止自身子进程。`wallet-disabled` 与 `local-disabled` 的完整隔离协议分别自然退出 0，后者包含真实虚构 session_update 事件与确认。共享 Map、遗漏退役标志、内存绕过 codec、取消本地抑制四项临时负控均被检出。实现 SHA256 `f8a83c7fa272b6eba205bc353cd53d3a9ae89c05df76bdc0c16bc95cf75ff68f`，单元 `a90fa677f16642ede1634c1b0923e1c595063bc12eaac02d6e49647911a9628f`，值对照 `6729713f79e6879250e199005ec159ffe32b8d6ec13c668f2b7f5bac021ca0cf`，协议脚本 `db40936d7f36e6576631f08f5dbdbeb7cee436fff6d5e8c90f89cb040a229f10`；独立证据 `/private/tmp/imtoken-ephemeral-final-qa.e5zsp2o_`。这些正例不改变默认 SDK 安全检查失败或此前列出的上线限制。
- QA 的协议测试负控中，把 session_update 监听改为不会触发的事件会导致等待失败；但仅删去更新确认与事件等待，在正常调度下仍可能由于事件自然先送达而通过。因此现有脚本没有证明它能检出所有提前继续的时序；受控延迟、失败关闭和并发重置仍是后续接入阻塞，不能把该负控记为检出。
- 独立 QA 最终共检出 6 个临时负控：另有对象引用缓存和缺失更新事件两项在上述四项之外失败；删除等待负控仍按前条保留限制。当前内存 Map 没有硬性容量上限，未来接入前还需评估异常大量 session/数据及重复尝试的资源增长。

## 2026-11-13 钱包旧跳转的本地签名前置候选

- 新增尚未接入登录业务的 `src/lib/walletconnect-deeplink-guard.ts`。调用方须持有既有钱包互斥锁，并提供当前 provider/client/store、主网链 ID、当前账户、已批准 session、尝试归属及挑战。包装器绑定这些对象和会话身份，验证钱包 peer、有效期、批准的主网账户和 `personal_sign`；仅对权威 Session Store 的 `sessionConfig` 设置本地 `disableDeepLink=true`，等待写入并重新读取，不回写旧 session 或权限。提供给钱包请求方法的参数固定为一次 `personal_sign`，结果返回前再次校验尝试、绑定、权限和配置；写入失败、会话删除/漂移、账户或链变化均失败关闭。调用方仍必须使用可信 provider 请求方法，在签名返回后、服务端 verify 和导航前复查自己的尝试；此包装器不处理 nonce 或 verify。
- 配置其他字段与授权 namespaces 分别按有界 JSON 形状做值快照，拒绝循环、过深/过多数据及访问器，避免异步等待中嵌套对象原地变化；不支持的配置会保守失败。同步生命周期和 SDK 读取如果误返回 Promise，拒绝并处理其拒绝，不能当成有效状态。`provider.session` 与权威 Store 不要求是同一对象或拥有相同的本地配置，但双方的会话身份、有效期和批准权限必须一致。链/账户由调用方从真实 provider 当前状态提供，不是凭空推导。
- Node 22.23.3、禁网下最终 27 项隔离单元覆盖写入前后、取消、拒绝、会话/链/账号/配置漂移、嵌套配置、异常 Promise 和签名后复查。真实 UniversalProvider/SignClient/Core 2.26.0、隔离 WebKit、虚构本机 relay 和临时账号的协议实验调用该实际包装器；人为挂起本地 Store 写入后，断言签名请求尚未开始，期间完成真实虚构 session_update 及确认，再释放写入并验真签名；既有持久候选、重启恢复和另外三次签名断言仍通过。默认未抑制的零旧读取/零旧打开检查仍失败，不作通过。
- 独立 QA 复跑前一源码的 26 项单元及 2.26 的受控延迟协议；`wallet-disabled` 和实际包装器 `local-disabled` 各四次临时签名验真并自然退出 0，默认模式仍退出 1。使用项目真实 EthereumProvider 2.24.0、`showQrModal=false`、虚构钱包和旧选择，独立调用该包装器完成临时签名验真，活跃 Client/Core 版本核对为 2.24，所测旧选择读取和打开均为零，原值保留。7 项源码负控及删除写入等待的受控协议负控均被检出；证据 `/private/tmp/imtoken-deeplink-guard-qa.7nc2uab4`。包装器 SHA256 `5bf520e55be0cf6551989b6c0b9f5ad3ed644dcd3e40d9e220b68311293238ff`，单元 `d1797e1d1d95e48eb702aea17f8052a79f574fa3b4d8da8f041f2ec71c81caa9`，协议 `afa0c81b7d9e56896d3f9a9bbcf3b0b59a53d53a1c2d52f3345fa39e3978adfd`。
- 此本地设置不是钱包协商结果，不能补救已进入 SDK 的请求；其他代码若在最终读回与 SDK 捕获 session 之间修改 Store，包装器不能阻止已发生的自动打开。SDK 内部异步操作不受页面锁完全控制，实际资源停止与并发重置仍须验收。禁用自动打开可能影响同设备手机钱包切换；真实扫码弹窗、钱包、手机、旧部署、Supabase、0037 正式预检/迁移以及默认失败检查均未完成。钱包依赖审计仍有 11 个 high 传播节点；PR #48 保持草稿，不能合并或称线上修复。
- 按既有 Claude 设计渠道完成同设备安全交互补充：[设计候选](../design/walletconnect-mobile-safety.md)。只有当前尝试的钱包目标经过工程确认和安全校验后才显示打开按钮；否则给手动切回或其他设备方案，不删除旧数据，也不声称取消可撤销已发 verify。该设计未接入或真机验收。请求 `devin/claude-opus-5-5` / `low`，使用量 15,748 输入、2,868 输出 token；接口接受不证明内部路由。当前聊天沿用用户界面所选 Terra Max，接口未返回主会话可见运行型号或强度，未改个人全局配置。
- 中英 1,572 键及完整 lint 在前一源码通过；最终源码的受影响文件 lint、无网络 Webpack 构建及 TypeScript 通过，构建保留既有 OG `maxWidth: none` 提示。
- 另用真实 2.24/2.26 SDK 引擎方法、虚构存储/发送桩和系统禁网各完成 5 项请求时序对照：签名前完成写入及读回时没有旧 deeplink 读取；若请求已捕获旧 session 后才设置标志，SDK 仍可读取旧值。普通 namespaces/expiry/ack 部分更新保留标志；持久化拒绝即使已改内存 Map 也必须失败；等待中删除 session 后不得恢复旧记录。该对照没有真实 relay 或手机，证据 `/private/tmp/imtoken-local-session-policy-qa.4ns80nol`，脚本 SHA256 `909ba214d86361046a773ecacf2161d724c6527132975a085db98c1e7fcee82a`。

- 最终候选将授权 namespaces 快照也改为有界遍历，过大、过深、循环或非支持形状保守拒绝，可能拒绝超限的有效会话；该限额不是整个 SDK 收包或资源硬上限。独立 QA 对最终源码增量复跑 27 项单元、真实 2.26 受控协议四次虚构签名，以及真实 2.24 无弹窗路径一次虚构签名，均通过并自然退出 0；2.24 所测旧选择读取和打开均为零、原值保留。移除 namespaces 限额的源码负控按预期失败。最终包装器 SHA256 `cf1c4348c8aa630200b55611dc334db6ad7609bce1fb3c3166fd9a2680f5d231`，单元 `a809dbdccf7fa759e63e8007a98935644572370c51b5f7c7421058fd96beb6e7`；协议未改，独立增量证据 `/private/tmp/imtoken-deeplink-guard-qa.7nc2uab4/namespaces-increment/README.md`。以上均为虚构账号及本地服务，不能代表真实钱包、手机、线上或所有 SDK 路径。

## 2026-11-13 WalletConnect 尝试生命周期协调候选

- 新增尚未接入登录业务的 `src/lib/walletconnect-attempt-coordinator.ts`。同一协调器同步占用尝试位，取消只退役该尝试，不把 SDK 初始化、连接、签名或其他在途 Promise 当作已结束；业务完成后等待资源 owner 的 `close()` 才释放。清理失败时保留占位，允许原 owner 单飞重试；未知 owner 时保持阻塞，不提供丢弃占位的快捷方式。旧 handle 无法取消或清理新尝试；清理阶段及之后的旧 UI 回调不再经 `publish` 交付。
- `result` 可在清理失败时拒绝，此时 `released` 仍未完成；未来接入必须在现有共享钱包锁的 `finally` 中等待 `released`，并为失败清理提供可追溯的恢复。owner 必须在 SDK 工作前同步确定、将真实在途工作纳入自己的 Promise，并使 `close()` 可安全重试且记住已成功步骤；调用方还须在 nonce、签名、verify、导航和 UI 更新处配合尝试检查。无响应的操作或未知 owner 可能无限阻塞；这项设计不自动取消 SDK 请求、不撤销已发服务端请求，也不保证所有后台资源停止或跨标签/跨文档隔离。
- Node 22.23.3、系统禁网下 30 项隔离单元、受影响文件 lint 和 TypeScript 通过。真实 UniversalProvider/SignClient 2.26.0、系统仅允许本机回环的虚构 relay 和临时钱包下，取消后钱包仍批准旧连接：协调器在迟到批准和受控挂起的清理结束前拒绝新尝试，不交付迟到回调或发起后续签名；释放清理后确认双方所测 session 删除，随后允许新尝试。整体协议实验 9 个场景自然退出 0；该场景 owner 只等待 session disconnect，SDK Core 心跳/传输在测试夹具退出时另行关闭，不证明 pairing 或全部 SDK 资源已清除。SDK 的 20 次 Verify 外部尝试被拦截，其他账号、服务、relay 与签名均为虚构。
- 独立 QA 发现初版并发非法 Promise 参数存在未处理拒绝、清理失败后旧业务 context 仍能回调，均已修复并独立复测；逐项读取时后续 getter 抛错及异常 aborted 属性也有受影响回归。最终独立复跑 30 项单元、9 项 2.26 协议场景自然退出 0；六类源码负控（占位、取消、清理等待、owner 比较、业务阶段、未知 owner 阻塞）均按预期失败。真实协议删除清理等待的负控也检出提前放行；其有界父进程终止自己的 worker 并保持失败，不计作清理成功。两步虚构清理对照中断开成功一次、存储清理第一次失败后重试一次，协调器在成功前不释放，旧失败结果不恢复；步骤记录是 owner 契约，不是协调器自动完成的 SDK 清理。证据 `/private/tmp/imtoken-attempt-coordinator-qa.d_cut6lg/README.md`。
- 最终协调器 SHA256 `3557c360d0c71095b9c61a8aeb6e9939e26f791b96955d7dfe4c6c80348469f5`，单元 `a8819ff3fbefd70311f8bcd3797ca5076f58ac8316a3b310d8aa2dad650213d5`，协议 `769fed5d763e4f17369fb397a97e7790fa6eafbacdbacfa79710615102d3625b`。当前 SDK、扫码 UI、业务接入和依赖未替换；旧 SDK 双标签迁移及默认旧 deeplink 安全检查仍失败，11 个 high 依赖传播节点、0037 正式预检/迁移、旧部署和回退、真实钱包/手机仍待处理。PR #48 保持草稿，不得合并或称线上修复。

## 2026-11-13 WalletConnect 显式资源 owner 候选

- 新增尚未接入登录业务的 `src/lib/walletconnect-attempt-owner.ts`，与既有尝试协调器组合：先同步建立 owner，再为每次尝试建立独立内存 storage、值编码层和随机 prefix，单次构造 Core、初始化 Provider 和连接；核对实际 `provider.client.core`、Core storage 和 prefix，发现未知或漂移的资源时不触碰外来资源并阻断释放。只卸载本 owner 注册的 URI listener；捕获 topic 而不保存完整 URI，最多记录 256 个 pairing topic，session/self/pairing 标识限定 64 位小写十六进制。这里只检查 URI 的 topic 形状，未来界面仍须验证完整 URI、不记录连接密钥。
- 签名前记录本地 session topic、self key 和 pairing topic；分步等待当前 session 断开、发起本地 pairing 清理、核对 session/pairing Store、已捕获 key、expiry 和 active/pending/cached subscription，再停止 heartbeat、关闭 transport 和退役内存 storage。SDK 的 pairing 清理方法会吞错并触发异步删除，因此仅在实际本地组合检查完成后继续，短暂等待后仍未完成则失败并保留槽位；`expirer.has` 自身会吞内部错误，不能单独证明清理。远端 pairing 删除、所有后台任务停止和内存中全部密钥副本清除均不在该结论内。
- 清理进度只在步骤成功后记账，重试不重复已证实断开；断开拒绝后 session 已消失时不能推断后续密钥清理已完成，保持歧义阻断。同步抛错或非 Promise 的异步契约可能已启动未跟踪工作，此时保留 owner 和槽位，不用超时冒充结束；跨异步边界复查 Core/provider 所有权。未知初始化、持续挂起或歧义失败可能无限阻塞，未来调用方须在现有共享钱包锁中等待 `released` 并提供可追溯恢复。调用方仍须使用实际授权 session/账户/链 guard，且在 nonce、签名、verify、导航和 UI 回调边界检查尝试；本批未实现新的登录流程。
- Node 22.23.3、系统禁网 32 项单元、受影响 lint 与 TypeScript 通过；真实 Core/UniversalProvider/SignClient 2.26.0、虚构本机 relay 和临时钱包的 10 场景、9 次虚构签名自然退出 0，新增场景核对独立 Core/storage、双方所测 session 删除与本地 session/self/pairing key、pairing Store 和 subscription 状态。SDK 21 次 Verify 外部尝试被拦截；系统允许其他本机回环端口，测试不是文件系统隔离。
- 独立 QA 发现初版异步契约同步失败可丢失隐藏工作、transport 等待期间所有权漂移仍可释放，均已修复并复测。最终独立复跑 32 项单元、10 项协议场景及 17 个定向病例；6 类源码负控（错误 Core、跳过本地残留检查、不卸载 listener、取消未跟踪工作阻断、删除所有权复查、删除 URI 数量上限）均按预期失败。另用真实 2.26 的独立虚构 relay 场景验证取消后钱包才批准：不进入 `onConnected`，迟到 URI 不交付，受控 disconnect 未完成前仍占位；完成后核对双方所测 session、本地 pairing/key/expiry/subscription，之后才允许新尝试。证据 `/private/tmp/imtoken-attempt-owner-qa.5oe728qu/README.md`。
- 最终 owner SHA256 `f6ca40586fab2edb78774f65c9c50a0e42081cf3da0abc229443b2081c817e68`，单元 `be06d35f59780970890e6ae7558039c7b446426ebb684a38c31fdb7422bcc9d7`，协议 `a69dfcb51ab9c6fea66f19347bbe423c3b94b4d49ef934d42f7ae730e4b48c42`。当前 SDK、扫码 UI、业务接入和依赖未替换；原 SDK 双标签旧存储迁移及默认旧 deeplink 安全检查仍失败，11 个 high 依赖传播节点、0037 正式预检/迁移、旧部署和回退、真实钱包/手机仍待处理。PR #48 保持草稿，不得合并或称线上修复。当前聊天沿用用户所述界面选择 Terra Max；本接口未返回主会话可见运行型号或强度，独立 QA 复用既有子 agent，未修改个人全局配置。

- 本批开发期间同步已发布 main `779cb8e`（合并提交 `8adef38`），保留 PR #43 回复/通知组件与 PR #49 依赖版本，以及本分支原有两项直接依赖。93 项回复/通知隔离回归、中英 1,572 键、完整 lint、无网络 Webpack 构建及 TypeScript 通过；构建保留既有 OG `maxWidth: none` 提示。独立合并 QA 核对依赖、锁文件、组件与双方路线图，未发现阻塞；证据 `/private/tmp/imtoken-merge-security-qa.rmoit4c3/README.md`。这些是分支整合检查，不代表真实钱包/账号/手机或数据库验收。
