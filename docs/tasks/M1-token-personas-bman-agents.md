# M1 首页数字币人同步 bman Agent

日期：2026-10-16。状态：实现与本地验证完成，等待 PR / 用户 review。

## 需求

首页右侧「数字币人」不再使用 BTC、ETH 等占位人物，改用 bman `presets/agents.yaml` 现有 Agent 的公开名称与头像；点击后进入对应 Agent 详情页。综合交流中的原本地圈子预览不在本批修改。

## 数据与路由基线

只同步 bman `3371aa4` 中公开展示字段，不复制 owner 或 Soul：

| 显示名 | 头像来源 | 详情路由段 |
| --- | --- | --- |
| ZEC | `bman-assets.buidl4.top/agents/zec-…webp` | `$ZEC` |
| NEAR | `bman-assets.buidl4.top/agents/near-…webp` | `$NEAR` |
| 牛来 | `bman-assets.buidl4.top/agents/niulai-…webp` | `$牛来` |
| TRON | `cryptologos.cc/logos/tron-trx-logo.png` | `$TRON` |

bman `src/lib/agent-symbol.ts` 的 `agentSymbolParam(name)` 明确生成 `$<symbol>`；Token Fans 使用 `encodeURIComponent` 生成字面 URL，例如 `/agents/%24ZEC`。

## 实现

- `src/lib/bman-agents.ts` 保存四项受控展示清单与唯一 URL 生成函数。
- `TokenPersonasCard` 只在首页 external 模式使用 bman 清单；综合交流继续使用五个本地预览角色和弹窗。
- 首页桌面改为 2×2，手机改为 4 列；名称按用户约定不显示 `$`。
- `next/image` 仅放行两个实际远程路径范围。由于本机代理把公网域名解析为 `198.18.0.0/15` fake-IP，远程 Agent 头像使用 `unoptimized` 由浏览器直连，未启用有 SSRF 风险的 `dangerouslyAllowLocalIP`。
- 中英文访问名称与说明同步更新。

## 边界

本批不动态读取 bman、不修改 bman、不接 Agent 账号/@回复/数据库，也不改变综合交流占位人物。后续 Agent 持久回复见 GitHub Issue #33。
