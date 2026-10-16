# Agent 模型清单与选择依据

更新：2026-10-15。模型目录和价格表为 2026-10-14 核对快照；CLI 渠道验证与角色 v2 已补齐。本文件不保证永久可用性或全局最优。
配置以 `.codex/config.toml`、原生 `.codex/agents/*.toml` 与外部 `.codex/external-agents/designer.toml` 为准；使用方法见 [工作流](agent-workflow.md)。

## 1. 原生子 agent 与外部设计调用

2026-10-14/15 先前会话的 `collaboration.spawn_agent` 配置与验证快照包含以下 7 个模型覆盖值（本轮运行时已不同，见下文）：

| 模型 ID | 本项目用途 |
| --- | --- |
| `gpt-6-luna` | developer 小任务的显式覆盖 |
| `gpt-6.1-sol` | 主调度、统一开发、风险 QA |
| `gpt-6-astra` | 可选模型，没有默认角色；用户需要时再定向使用 |
| `gpt-6-sol` | 可选旧版本回退，没有默认分配 |
| `gpt-5.6-luna` | 可选旧版本回退，没有默认分配 |
| `gpt-5.6-terra` | 可选旧版本回退，没有默认分配 |
| `gpt-5.6-sol` | 可选旧版本回退，没有默认分配 |

这些是先前会话的模型快照，不意味着当前接口仍接受，也不意味着逐一实测全部 7 个。冒烟验证记录见文末。

本机 CLI 为 `codex-cli 0.147.0`。本次读取桌面已加载的模型缓存时可见上述 7 个 OpenAI 模型；随后运行 `codex debug models` 刷新，CLI 目录只列出 5.6 的三个 OpenAI 模型及第三方入口。两个客户端的目录存在差异：CLI 目录不能作为当前聊天 6 系列不可用的依据，也不能把桌面缓存当作 CLI 已验证支持全部模型。当前调度以聊天工具声明和实际运行回执为准。

### 第三方入口：原生接口不接受，Devin CLI 已实测

CLI 目录列出以下入口。其中 `devin/claude-opus-5-5` 已通过现有 magpie provider 真实调用成功，成为当前设计角色；最终脚本也有成功回执。`cursor/claude-opus-5-5@300k` 调用被地区限制拒绝。其余入口未逐一验证。原生 collaboration 的模型覆盖仍只接受上表七个 OpenAI 模型，不能把 CLI 成功误写成原生 Claude 子 agent 已可直接启动。

- `cursor/auto`
- `cursor/grok-4.7@256k`
- `cursor/grok-4.7@500k`
- `cursor/grok-4.6`
- `cursor/composer-2.5`
- `cursor/claude-opus-5-5@300k`
- `cursor/claude-opus-5-5@1m`
- `cursor/claude-opus-5@300k`
- `cursor/claude-opus-5@1m`
- `cursor/claude-opus-4-8@300k`
- `cursor/claude-opus-4-8@1m`
- `cursor/gpt-5.6-sol@272k`
- `cursor/gpt-5.6-sol@1m`
- `cursor/gemini-4-argon`
- `cursor/gpt-5.5@272k`
- `cursor/gpt-5.5@1m`
- `cursor/claude-fable-5-1@300k`
- `cursor/claude-fable-5-1@1m`
- `cursor/claude-fable-5@300k`
- `cursor/claude-fable-5@1m`
- `cursor/grok-4.5`
- `cursor/gemini-3.8-flash`
- `cursor/gemini-3.7-flash`
- `cursor/muse-spark-1.3@300k`
- `devin/claude-opus-5-5`
- `devin/swe-2`

隐藏的内部模型不纳入调度。第三方默认设计渠道只选已验证的 Devin；不把其他目录入口自动加入模型路由。

## 2. 对比旧模型后的成本结论

以下为核对时官方 API Standard、短上下文、非缓存价格（USD / 100 万 tokens），用于比较模型单价；不是用户在 Codex 的实际订阅账单或额度换算。推理输出、输入长度、缓存、服务档位和返工都会影响任务成本。

| 模型 | 输入 | 输出 | 选择判断 |
| --- | ---: | ---: | --- |
| GPT-6 Luna | 0.10 | 0.50 | 已验证公开单价低于 5.6 Luna，作为轻任务默认 |
| GPT-5.6 Luna | 0.20 | 1.20 | 版本较旧不代表成本更低 |
| GPT-6.1 Sol | 2.00 | 10.00 | 核心工作默认，价格低于 5.6 Sol，输出低于 5.6 Terra |
| GPT-5.6 Terra | 2.00 | 12.00 | 可回退，不因旧版本而优先 |
| GPT-5.6 Sol | 4.00 | 20.00 | 可回退，不作为节省成本的默认 |
| GPT-6 Astra | 10.00 | 50.00 | 只在难题升级时启用 |

来源：[当前价格](https://developers.openai.com/api/docs/pricing)、[5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)、[5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)、[5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)、[6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)。

**因此保留 Luna + Sol 为主并不是因为只考虑了 6 系列，而是旧系列目前没有公开单价优势。** 未对所有模型做真实工程质量评测，不能声称已经找到全局最优。

## 3. 提升性价比的方法

- 一次只调用所需角色，普通任务不召集全体 agent，不默认使用最高推理强度。
- 给便宜模型明确上下文和任务卡，不把完整聊天历史反复传给每个 agent。
- 新 agent 优先使用简短交接；当前接口改模型时采用独立上下文启动，角色 Prompt 与相关资料显式传入。
- 简单局部调整由 developer 使用 Luna；跨组件、权限或迁移使用 Sol，避免低价模型反复试错。
- 独立复核重点变更；小文案修正由 i18n 检查和主调度核验即可。
- 在前 3–5 批任务记录用量（工具实际提供时）、耗时、返工及验收；没有成本数据就标未知，不编造节省百分比。
- Claude 只接收精简 Brief、设计参考与集中反馈；普通开发、日志分析和小调整交 GPT。

## 4. 当前 v2 角色与验证

| 角色 | 模型 | 调用路径 |
| --- | --- | --- |
| 主调度 | GPT-6.1 Sol / medium | 主聊天 |
| 设计 | Claude Opus 5.5 / low | `scripts/run-claude-design.py` → 现有 magpie/Devin |
| 统一前后端开发 | GPT-6.1 Sol / medium，小任务可用 Luna | 原生 developer |
| 按需 QA/安全审查 | GPT-6.1 Sol / high | 原生 qa |

旧 explorer/copywriter/frontend/backend/fixer/reviewer/architect 等九角色方案已归档，不再作为默认调度表。独立 QA 仅在风险矩阵命中、阶段验收或用户要求时启用；普通改动由开发自检。

原 v1 的 Luna/Sol 原生只读调用已成功。v2 的 Claude 实测中，ChatGPT 默认渠道返回 400、Cursor 返回 403 地区限制、Devin 返回成功。最终脚本请求 58 字符 Brief，回执报告输入 11,611 tokens、输出 17 tokens，并另报缓存写入字段；不能将各字段简单相加或套官方 API 单价当作 Devin 账单。

验证证据：[真实连接回执](agent-validation/claude-route-2026-10-14.json)、[安装与离线检查报告](agent-setup-validation.md)。

2026-10-15 收尾没有重复发送付费模型探测；使用保留的真实回执，并离线验证最终脚本、当前配置与文档。未验证：新聊天原生角色 UI 自动发现、第三方内部模型路由、真实设计质量/成本评测、Cursor 地区限制解除。当前工作流不依赖这些未验证项完成显式分派。

## M1-B 当前会话限制（2026-10-15）

原生分派实测返回：`gpt-6.1-sol` 不可用，继承的 `gpt-6-luna` 同样不可用；实际错误列出的模型为 `cursor/auto`、`cursor/grok-4.7@256k`、`cursor/grok-4.7@500k`、`cursor/grok-4.6`、`cursor/composer-2.5`。`cursor/auto` 创建后因提供方无法解封当前任务上下文而失败，未执行开发。主调度继续本批低风险改动；配置文件保留为预期分工，不把工具目录可见等同实测可用。本批未调用 Claude，实际模型账单未知。
