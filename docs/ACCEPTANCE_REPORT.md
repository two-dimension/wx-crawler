# 实施与验收记录

记录日期：2026-10-30（Asia/Shanghai）。实现版本：0.1.0。

当前结论：首期代码、安装配置、九个 MCP 工具、真实搜索归档与导出闭环已交付，浏览器逐请求网络拦截已补齐并通过真实 Chrome 测试。2026-10-30 用户明确要求“人工核对先不做”，因此人工样本核对暂缓，不作为本轮项目交付的前置条件。**本轮实现与自动验证交付完成；原方案的人工准确率验收未执行。** 自动对照和人工核对材料不会被当成人工结果。

## 环境与锁定依赖

| 项目 | 受测结果 |
| --- | --- |
| 系统与路径 | Windows，D:/实习任务/wx-crawler；自动测试另在中文临时目录运行 |
| Node/npm | 24.15.0 / 11.12.1 |
| MCP SDK | @modelcontextprotocol/sdk 1.32.2，项目 package-lock.json 锁定 |
| 客户端与传输 | 官方 SDK Client + StdioClientTransport，真实子进程；InMemoryTransport 用于取消等契约检查 |
| 协议 | 真实初始化协商 2025-11-25；记录于 data/live-smoke-report.json |
| OpenCLI | 项目本地 2.0.2；全局原版本 1.8.5 不参与运行 |
| 默认浏览器 | Chrome 156.0.8078.48，Playwright Core 1.64.1，managed_chrome 后端 |
| Bridge | 初期 doctor 检测扩展 1.0.26；当前仅保留诊断，不用于缺少拦截保护的采集 |
| 浏览器会话 | data/browser/wechat-crawler 独占 profile；单服务串行，Cookie 留在 Chrome profile 内，不进入工具输出/日志/导出 |
| 适配器 | 本项目固定 worker，不加载用户适配器；wx_status 返回 worker/managed/cancellation/resolver 文件及组合 SHA-256 |
| SQLite | Node 内置 node:sqlite；Windows 无需编译 native addon；迁移版本 1，WAL 与实例锁通过测试 |
| 依赖审计 | npm audit --omit=dev：0 个已知漏洞；undici 统一 override 到 7.30.1，zod 4.6.7 |

## 已完成验证

`npm run check`：TypeScript 构建通过，35 项检查通过，另 2 项真实 Chrome 集成测试默认跳过。`npm run test:browser` 单独通过 3 项（含 1 项与标准检查重叠的策略单元测试），两个实际 Chrome 场景均已运行通过。不是把跳过视为通过。

在用户决定暂缓人工核对后，重新运行上述两条命令，结果相同；同时核实真实闭环报告的 17 次调用均成功、浏览器 worker/guard/cancellation/resolver 指纹与当前构建一致，三种格式的导出清单均为完整且对应文件存在。该复核未重复访问真实来源。

- MCP 初始化、九个输入/输出 schema、工具列举、结构化业务错误、真实 stdio 通信、取消传播及取消后不归档。
- 标题/账号/日期、富文本块、代码、表格、图片、音视频和附件引用；验证码、删除、限流、认证、受限预览与空页面识别。
- 搜狗签名文章 URL、保留 sn/signature、移除临时 token、来源白名单、HTTP DNS 公网约束与跳转验证。
- 缓存命中、失败刷新保留旧版本、同一身份的别名、并发重复输入、跨账号转载不合并。
- 中文和中英数字混合子串检索、精确账号过滤、日期左闭右开和非法日期拒绝。
- 严格筛选先于归档、完整/部分计数、幂等冲突、预算截断、验证等待、发现分页检查点、暂停/恢复/取消、中断恢复。
- 超长块可读完全部分片；图片失败独立于正文、只补抓缺失媒体；三种导出固定版本、缺失媒体不标记完整。

真实 Chrome 集成测试使用合成页面与本地 HTTP/WebSocket 请求陷阱，确认直接请求、HTTP 重定向、图片/iframe、脚本请求、WebSocket 均未连接到陷阱。启动前拒绝非公网 DNS，固定允许主机地址，逐页 CDP Fetch 从 Request 阶段检查每一跳；自检失败则不导航。另在浏览器已启动的检查点取消真实子进程，再立即复用同一 profile，确认取消会先关闭 Chrome；服务停止时也会取消未完成 HTTP 请求再关闭数据库。

真实 stdio 客户端完成 17 次工具调用：搜索 → 候选抓取 → 阅读 → 本地检索 → 重复 URL 批量任务 → 状态查询 → Markdown/JSONL/HTML 导出 → 来源状态。最终 `ok=true`，不是用 fixture 替代来源。完整记录保留在被忽略的 data/live-smoke-report.json。

真实图片路径先后下载过 431803 字节 GIF 和 16411 字节 PNG；最新单张检查记录在 data/media-smoke-report.json，响应类型、字节预算与落盘通过。范围仅为单张媒体，不代表全部样本图片均已下载。失败或超限流量也消耗任务共享字节预算，耗尽后不再发起下一张请求，该边界另有受控流测试。

真实浏览器正文读取另做独立检查：人为注入 HTTP 网络失败，随后使用实际受控 Chrome 读取真实文章，不模拟浏览器响应，标题、公众号及 biz/mid/idx 与 HTTP 结果一致。注入性质保留，不能描述成自然发生的 HTTP 故障。当前记录在 data/browser-smoke-report.json、data/managed-live/browser-smoke-report.json 和样本报告 browser_fallback 字段；早期 Bridge 记录仅作为历史证据。实测中的瞬时来源错误未转换为空结果。

## 真实样本抽查

2026-10-30 12:16–12:30（Asia/Shanghai），在默认受控 Chrome 后端低频检查 28 个候选，覆盖科普、产业分析、政策、Python 教程、产品、代码实例、表格与壁纸等查询。更早的 Bridge 批次未替代本轮验证。

| 指标 | 结果 |
| --- | --- |
| 实际检查候选 | 28 |
| 可归档文章 | 25 |
| 正文 complete / partial | 22 / 3 |
| 标题与独立浏览器 DOM 对照 | 25/25 相符 |
| 公众号名称与独立浏览器 DOM 对照 | 25/25 相符 |
| 已删除 | 1，明确错误，未作为成功正文归档 |
| 无法识别正文 | 2，PARSE_FAILED，未作为成功正文归档 |

样本明细在 data/sample-acceptance-report.json，包含查询、时间、最终 URL、方法、状态、警告、字段对照与错误。该报告中的 character_presence_ratio 是自动烟测指标，不是语义准确率、逐块完整率或人工核对结果。human_reviewed=false。原文与媒体未提交到 fixture，fixture 为合成内容。

真实样本发现并修复了：搜狗签名 URL 被拒绝、脚本表达式/data-idx/全局计数器被误作文章身份、浏览器在 DOM 读取完成前被关闭。身份解析限定在经过格式核验的脚本声明；链接与正文身份冲突时保留原归档并报错。另补齐独立/图片外链、unsupported 图形块、元数据空值原因及“原创”标记不作作者的检查。

## 来源能力矩阵

| 来源 | 当前验证范围 | 其余能力 |
| --- | --- | --- |
| opencli_sogou（兼容来源 ID） | 实际后端 managed_chrome，真实关键词发现、候选缓存与跳转 | 不保证全站召回；相对时间不作为准确发布时间 |
| wechat_link_resolver | 普通微信短/长链接与搜狗签名跳转 | 跳转可能失效，验证码需人工处理 |
| public_http | 多篇公开图文、元数据、正文、单张图片下载 | 认证/付费/验证不自动切换路径 |
| opencli_browser（兼容来源 ID） | 实际 method=managed_chrome，真实 DOM 快照与正文兜底 | 依赖已安装 Chrome/Edge；旧 Bridge 后端仅诊断 |
| 账号身份 | 正文可确认 biz 时建立账号记录 | 不注册独立账号解析工具；缺少 biz 不按名称合并 |
| 历史/增量/feed/OCR/转录 | unsupported 或后续扩展 | 未注册条件历史/同步工具，不伪造空历史 |

## 尚未完成的验收与差异

1. **人工样本验收按用户要求暂缓。** 原方案 15.1/15.2 要求至少 20 篇人工确认可访问、至少 19/20 逐块核对标题、账号、正文及发布时间；本轮不执行这一人工关口，也不宣称已达到该准确率。本轮只有 25 篇自动 DOM 对照。data/acceptance/review.html、manifest.json、human-review.template.json 保留固定的 25 篇正文版本；页面初始化不勾选，下载/表单功能通过独立 UI 烟测，human_reviewed 仍为 false。日后恢复人工验收时，仍须核实全部指定类型覆盖；确认材料不足时补充样本，不能代填。
2. **浏览器实现调整。** 原 Bridge 不提供所需拦截接口，因此默认改用 Playwright Core 管理的专用 Chrome，并保留来源 ID 兼容；实际后端、方法与组合哈希明确披露。旧 Bridge 采集被拒绝，未提供无保护开关。此差距现已通过实现和原生测试解决。
3. **客户端范围。** 已通过官方 SDK 的实际 stdio 客户端验证，未把服务写入用户的桌面客户端设置；README 提供通用配置。其他 MCP 客户端仍需各自接入验证。
4. **来源恢复。** 来源能力与熔断状态为进程内缓存，重启后回到 unverified；任务与检查点持久化。签名链接在可靠取得 biz/mid/idx/sn 时转换为稳定长链接，否则明确警告 canonical_url_may_expire。过期搜索候选需重新发现。Retry-After 超出自动等待预算会保存冷却时间进入 waiting_source，提前 resume 被拒绝。
5. **快照与媒体。** snapshot.html 是清洗后的 HTML/DOM 快照，不是原始服务器响应，不能直接作为可信可执行页面展示。未识别媒体明确警告/partial，首期不 OCR、不下载音视频、不回补历史。

## 复现与继续验收

```powershell
npm ci --ignore-scripts
npm run check
npm run test:browser
npx tsx scripts/live-smoke.ts
npx tsx scripts/browser-smoke.ts
npx tsx scripts/media-smoke.ts
npx tsx scripts/sample-acceptance.ts
# 原始候选包含删除页时，可继续补充自动样本
npx tsx scripts/sample-acceptance.ts --supplement
npm run review:prepare
# 由实际验收人员填写并下载 JSON 后导入
npm run review:verify -- --file <实际人工结果文件路径>
```

真实脚本会访问来源、写入数据；同一数据目录不要同时运行这些脚本或 MCP 服务。登录、验证或限流发生时保留报告，完成本地处理后显式重试。不要高频重跑来源验证。

完整需求映射见 REQUIREMENTS_AUDIT.md。本轮按用户最新要求完成项目交付；保留原始方案及人工核对工具，后续可继续执行原方案的人工验收。当前自动测试、真实来源闭环与核对页均不构成人工准确率证明。
