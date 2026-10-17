# 15页路演入库与独立Vercel发布

2026-10-17，用户授权提交最新本地PPT至GitHub并部署可供其他电脑使用的Vercel网页。延续PR37 codex/roadshow-polish，隔离worktree，开工fetch并合并最新origin/main及同名远端任务分支。保留主工程与旧路演材料。

本批：用本地15页含荣格页最终HTML替换仓库14页版，内嵌图片/音轨不变；增加仅作用于deliverables/roadshow目录的静态vercel.json，部署到独立imtoken-fans-roadshow项目，不调整社区主站，不复制环境变量或真实数据。无新生图、无Next.js应用代码改动。

初步检查：15页/元数据一致、第6页插入位置、第7/13页演示、末页动态索引、脚本语法、原音轨/图片保留通过。计划匿名HTTP字节一致性、浏览器翻页/讲稿/音乐验证，结果与URL发布后补充。PR仍由用户决定合并。
