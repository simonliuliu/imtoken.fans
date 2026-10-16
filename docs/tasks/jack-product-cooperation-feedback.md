# Jack · Product Cooperation Feedback 主线整合

本记录保留上一批原型融合结果。后续用户要求直接实现真实业务，当前进度见 [真实发布与持久化](product-feedback-persistence.md)，不再提供原型种子和模拟Admin。

日期：2026-10-16。状态：本地分支整合与验证完成，待用户 review。

## 请求与基线

用户要求从原仓库当前 main 创建新分支，名字包含 jack 与 Product Cooperation Feedback，将上一批 IDEA 原型融合到「产品反馈」子模块；参考线上 https://imtoken-fans.vercel.app/zh/community/feedback 。

- 仓库：https://github.com/simonliuliu/imtoken.fans
- 新分支：`codex/jack-product-cooperation-feedback`
- 主线基线：`e1c40b1acf0eac4d5df38763bd7cc11a19ec27ec`，获取于2026-10-16。
- 本地 main 已用 `--ff-only` 同步，之后创建任务分支。没有修改/推送 main。
- 原型13个明确文件先复制到本地临时备份，再按团队规则逐项暂存并staged stash保存；恢复时仅roadmap文本冲突，保留双方执行记录后解决。stash继续保留作为恢复点。

## 融合方式

线上目前产品共创采用现有标题、历史产品猎手/点子入口、全部/产品反馈/社区产品/产品公告分类及主线社区列表。保留这个外框，在产品反馈分类嵌入IDEA提交/查重、投票、评论、Admin演示编辑/公开标记、合并/撤销与进展视图。其他分类继续现有列表/详情，首页横幅、产品猎手、其他板块维持主线实现。

本批不启动新的视觉设计渠道：既有原型功能与主线规范内的组件整合。前台文案中英同步。本地演示不是数据库/真实Admin授权，原型限制沿用 [原型任务](cooperation-idea-preview.md)。

## 验证与限制

本批 check-i18n（1374键）、lint、tsc、`npm run build -- --webpack` 全部通过；构建有工作区外锁文件和缓存快照警告，不影响成功结果。默认构建器此前受本机端口限制，本轮不修改默认构建配置。

浏览器已对比线上外框和本地默认「全部」：标题/三个原帖子/产品猎手入口保留。实测「产品反馈」显示嵌入工具，支持票3→4，切到「社区产品」及「产品公告」仍显示各自原内容，返回反馈票数仍为4，取消后恢复3。中英文分类/嵌入声明及390px手机外观验证，随后恢复默认尺寸与中文反馈预览。原型核心合并/编辑/票逻辑未变，上一批独立QA结果仍有其范围限制；本批未再次运行真实库/多账号测试。

变更局限于原型、社区分类嵌入和文档；路由文件恢复为主线原样，首页/全局样式/产品猎手/迁移未改，messages仅新增cooperation命名空间。截图：[桌面融合预览](../reviews/screenshots/jack-feedback/integrated-desktop.png)。

未部署或合并到main。用户没有原仓库写权限，后续上传采用其Fork+PR，不尝试扩大权限或代替仓库所有者合并。
