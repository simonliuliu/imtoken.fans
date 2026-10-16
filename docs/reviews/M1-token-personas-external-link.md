# 首页数字币人外链 review

2026-10-16 · 本地验证通过，待用户 review。

首页任意数字币人现在直接进入 [B-Man 综合](https://bman.buidl4.top/c/general)，不再先弹出占位圈子预览。头像与名称属于同一可点击区域，使用浏览器原生链接和当前标签页导航。综合交流的原预览保持原行为。

## 实测

- `npm run check-i18n`：通过，1251 个双语键。动态键提示为信息，不是失败。
- `npm run lint`、`npm run build`：通过。
- ego-browser：1440×1000 中文首页及 390×844 英文首页各有五个完全相同的目标链接，无全页溢出。桌面 BTC 与手机 Niulai 实际点击均进入指定 URL，目的页标题为「综合 - B-Man」。
- 综合交流：五个角色预览按钮，未被首页外链模式替换。
- 无数据库、登录、权限、AI 或外站账号操作；不验证外站内部业务能力。

## 截图与本地查看

- [桌面中文](screenshots/token-personas-link/desktop-zh.png)
- [手机英文](screenshots/token-personas-link/mobile-en.png)
- [本地首页](http://localhost:3000/zh)，固定端口 3000。当前运行 `npm run start`；若继续修改代码，先在运行服务的终端停止，再运行 `npm run dev` 查看即时变化。

本批在 `codex/token-personas-external-link` 分支交付，通过 PR review 后再由所有者决定合并。未部署线上。
