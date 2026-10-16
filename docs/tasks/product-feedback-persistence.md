# 产品反馈真实发布与持久化

日期：2026-10-16。状态：代码接入与独立审查完成；目标Supabase反馈迁移待执行，未作为上线验收。

## 用户要求

本批替换上一批内存原型：右上角「发帖」统一提交，在「内容类型」选择产品反馈后显示产品模块；管理员编辑IDEA描述必须真实保存；支持票、评论及其投票必须写库并在刷新后恢复。移除模拟管理员开关，使用真实论坛Admin权限。延续当前 `codex/jack-product-cooperation-feedback` 分支，不修改main。

## 已核对环境

当前目录只有 `.env.example`，没有 `.env.local`。用户确认本批只需完成接入代码；没有复制或输出密钥。本机无现成psql、Supabase CLI或Docker，工具未暴露Supabase管理连接。

开发中fetch发现主线更新至`67a5b53`，其[真实登录记录](vercel-live-auth.md)说明Production已配置原Supabase并执行0023/0024，Preview不复制Production凭证。已明确staged stash本批、merge最新main并恢复，无冲突；保留伙伴真实登录和数据库安全修复。本批反馈迁移因此使用0025，不能重用已占用的0024。主线已有真实连接不等于新反馈表已初始化。

账号/资料/产品猎手已有Supabase代码；当前社区IDEA仍独立内存数据。旧product/idea提交、旧评论/票和产品猎手记录必须保留，虚构示例不能自动写入真实库或伪造作者。

## 模型与迁移前置

开发负责新增反馈表、用户唯一支持关系、反馈评论及评论票、编辑审计、合并来源关系等方案。仅新增迁移，不改旧迁移。实际执行前记录依赖、表清单及回退：新增业务先停写，回退应用到旧版本；保留新增表和记录用于恢复，不通过删除真实数据回退。

真实Admin编辑与合并须服务端和数据库双层校验；支持使用显式设置而非重试toggle。接口失败必须显示错误，不把配置缺失/迁移未执行冒充空列表或保存成功。公开数据不包含邮箱/钱包地址或支持者名单。独立QA覆盖RLS、RPC鉴权、版本冲突、评论归属、去重、撤销和禁止直接越权写入。

## 验证记录

本批i18n（1432键）、lint、tsc与Webpack生产构建通过。主线6条登录安全回归通过。数据库最终71项PASS、0项FAIL，可复跑脚本随代码保存。独立审查修复并复测：旧Admin数据/在途read残留、Cookie切号窗口、旧表单跨号提交、草稿owner隔离、删号作者幂等归属以及合并支持来源幂等。最终SQL SHA256：`845ef09242ea08247015b5909710ed5c65ccc48720cc3b08a538a197a60bcc7e`。

浏览器实测统一发帖：右上角发帖切换产品共创/产品反馈显示产品模块；模块发布入口调用同一弹窗；字数与SQL一致；缺配置时真实报错并保留输入，不返回假成功；390px手机及桌面显示通过。最终截图见 [统一发帖](../reviews/screenshots/jack-feedback/real-compose.png)。旧wallet虚构详情重定向真实板块，虚构wallet投稿从内容流过滤，过期种子逻辑文件删除。

真实目标库迁移、真实账号保存/刷新/取消/管理员编辑、多连接并发与PostgREST接口仍待部署环境验证；本地PG和模拟身份结果不代替这些验收。现有线上Supabase配置不代表新增反馈表已存在。本批没有向目标库写数据，也没有部署或合并main。

## 数据库交接

新增迁移为 `supabase/migrations/0025_product_feedback.sql`。目标库需已有 `profiles`（含display_name、role、muted_until）及`user_tags`，对应原工程身份和治理迁移；保留主线0024。新表为 `feedback_posts`、`feedback_comments`、`feedback_post_votes`、`feedback_comment_votes`、`feedback_merges`、`feedback_audit`，不改写旧submissions/comments/votes或产品猎手数据。

部署人员在现有Supabase项目SQL Editor执行该迁移（事务内建表/函数/授权），确认成功后部署此分支代码。继续使用已有`NEXT_PUBLIC_SUPABASE_URL`和`NEXT_PUBLIC_SUPABASE_ANON_KEY`；新反馈读写不需要向浏览器提供service role，也不应新增高权限客户端密钥。原库的真实Admin账号由现有`profiles.role`确定，本批不自动提升任何账号权限。

公开客户端只调用`feedback_read`和`feedback_write`；基础表不直接开放客户端访问，支持者身份不公开返回。新功能未初始化时页面应明确提示，而不是以假数据替代。已有虚构IDEA不会导入，真实反馈需要由真实账号提交。

回退先撤下新增入口/回退应用版本，保留新增表与审计；不要删除真实提交来回滚UI。后续要迁移已有真实反馈时，另做作者、ID、历史链接和投票来源映射，不将演示文字当作用户投稿。

## 可复跑数据库测试

独立QA使用官方npm包`@electric-sql/pglite@0.5.10`，在临时PostgreSQL中创建模拟`auth.uid()`、anon/authenticated/service_role与合成账号，仅测试新增迁移，不读取真实用户或密钥。保留脚本为`scripts/tests/feedback-database.mjs`与`feedback-security-base.mjs`。不新增项目依赖或修改锁文件。

```sh
npm install --prefix /tmp/imtoken-feedback-qa @electric-sql/pglite@0.5.10
FEEDBACK_QA_PGLITE=/tmp/imtoken-feedback-qa/node_modules/@electric-sql/pglite/dist/index.js node scripts/tests/feedback-database.mjs
```

初轮结果59项PASS、0项FAIL，覆盖身份/禁言/黑名单/管理员权限、原表禁止直写、RPC参数、幂等、评论跨帖归属、编辑版本/审计隔离、隐藏内容、一层最早合并、撤销与取消票不复活。当前是单连接顺序测试，不代表多连接并发或目标Supabase/PostgREST/浏览器会话已验收。最终SQL变动后需复跑。

最终复跑扩展为71项，额外验证合并预览无写入、NULL参数、孤儿作者、重复支持不改变合并来源归属。发布策略为真实登录用户公开提交、Admin可隐藏/恢复；尚未接旧人工审核队列、通知和附件上传，不把本批称为完整反馈首版。视频文件仍是后续首版验收要求。

Actions首轮独立边界测试通过：缺配置返回configuration；未登录/普通用户编辑/禁言Admin/黑名单在RPC前拒绝；非法版本和非布尔票值拒绝；PGRST202映射迁移未初始化；未知SQL错误不回传细节、不显示成功、不revalidate；只有RPC成功才失效页面缓存。使用模拟客户端与翻译执行真实Actions函数，不代表目标网络/会话验收。

用户确认希望交付数据库接入代码，不提供本机环境文件路径。已搜索仓库配置入口：仅process.env引用，无可用实际连接字符串；线上登录页面按钮启用，但不从公共页面提取或复制部署密钥。目标项目迁移与真实多账号保存刷新验收仍需部署人员在已有Supabase环境执行。
