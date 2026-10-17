# 15页路演入库与独立Vercel发布

2026-10-17，用户授权提交最新本地PPT至GitHub并部署可供其他电脑使用的Vercel网页。延续PR37 codex/roadshow-polish，隔离worktree，开工fetch并合并最新origin/main及同名远端任务分支。保留主工程与旧路演材料。

本批：用本地15页含荣格页最终HTML替换仓库14页版，内嵌图片/音轨不变；增加仅作用于deliverables/roadshow目录的静态vercel.json，部署到独立imtoken-fans-roadshow项目，不调整社区主站，不复制环境变量或真实数据。无新生图、无Next.js应用代码改动。

初步检查：15页/元数据一致、第6页插入位置、第7/13页演示、末页动态索引、脚本语法、原音轨/图片保留通过。后续在线检查如下。PR仍由用户决定合并。

## 发布与验收结果

- GitHub PR37已推送源提交e8814d73c6b5c5d381ad95bee21ec80a34d906b3，15页含荣格新页。
- 独立静态项目imtoken-fans-roadshow，部署dpl_9HVeikcrkJgs42rAKDEsGEta9YMH，状态READY，生产地址https://imtoken-fans-roadshow.vercel.app/ 。不复用社区站/环境变量；未改主站项目和数据库。
- 匿名HTTP 200，9691800字节，SHA256为6402531f9f1459517a92b2ae30bd98a5362a71a2e49550e6d93b0877fc5b1cbf，与本地版一致。
- ego-browser实际检查：15页/24张图片加载、第6页展开和06/15计数、两次演示页7/13、讲稿与演讲者视图同步、演讲者控制前进到第7页、全屏进入/退出；第15页音轨未暂停且currentTime推进，无解码错误；后退淡出后pause且currentTime归零。
- 不将浏览器play状态等同真人听觉/投影或跨系统音量验收，Safari/真实外接屏未验。浏览器工具提示可更新，未升级。仅测试新公开站，没有绕过旧file导航限制。
- 1580键i18n通过，差异检查通过；静态材料/配置，无应用改动，不重复主应用build/lint。
- Vercel CLI既有访问token过期，通过正常whoami触发登录态刷新；未输出或提交凭证，没有改变账号授权范围。
- deployment.json记录源提交与部署，后续仅文档回填不触发内容变化。原本地15页HTML不变；PR37保持OPEN，未合并main。
