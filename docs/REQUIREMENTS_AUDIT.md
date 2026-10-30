# 实现方案逐项核查

依据：原始 `IMPLEMENTATION_PLAN.md`，保留原文。2026-10-30 用户明确要求“人工核对先不做”：本轮交付暂缓方案 15.1 和 15.2.1 的人工关口，保留未执行状态及后续核对材料。其他实现和验证要求继续适用。下表区分代码、自动化、真实上游与人工证据；条件扩展不作为首期已完成能力。

| 方案要求 | 当前实现与权威证据 | 结论 |
| --- | --- | --- |
| 1–2 普通图文、URL 批量、搜索、本地阅读/检索/导出闭环 | src/tools 九个工具；真实 SDK stdio 的 data/live-smoke-report.json（17 次调用） | 已实测闭环；人工准确率另验 |
| 3 上游与来源版本、业务状态、适配器指纹 | package-lock.json；wx_status 的 backend、Playwright/OpenCLI 版本、worker/guard/resolver 哈希；Bridge 缺拦截时拒绝采集 | 已实现；默认后端调整原因见验收报告 |
| 4 Node 24/TS/SDK/stdio/SQLite，日志不污染协议 | package.json、tsconfig、node:sqlite；真实子进程初始化、工具调用及退出释放锁测试 | 已验证 |
| 4.2 分离发现、跳转、HTTP、浏览器及解析 | providers、resolver、browser、parser 独立模块；固定 worker 操作，未接受任意 JS | 已实现 |
| 5 逐来源能力与覆盖范围、熔断 | ArticleService.status/mark/check；工具返回 coverage；未验证不报 available，历史不返回伪空集合 | 已实现；状态为进程内缓存 |
| 6.1 账号、会话、文章身份独立，不按名称合并 | accounts/account_provider_ids、独占 browser profile、文章完整三元组/URL；跨账号转载和冲突身份测试 | 已验证 |
| 6.2 元数据、正文、媒体、外链、质量、版本 | Article/Draft 模型；空值原因；单独媒体状态；正文、结构化 JSON、清洗快照落盘 | 已实现；真实性由逐篇核对确认 |
| 6.3 稳定版本内块 ID、支持块类型及引用 | parser；wx_read_article 引用和整块/超长块分片测试；SVG/canvas 等明确 unsupported | 已自动验证；实际复杂样本覆盖待人工 |
| 6.4 状态分开、异常提示不是正文、缓存不被失败覆盖 | 提示节点、付费预览、媒体失败、陈旧缓存与刷新等待测试；失败单篇记录 fetch_attempts | 已验证 |
| 6.5 身份/URL/别名去重、保留 sn、不同转载来源、并发唯一约束 | URL 模块、SQLite 唯一约束；同 URL 并发、别名、跨账号相同正文及身份冲突测试 | 已验证 |
| 7.1 输入输出 schema、结构化错误、取消、小结果和绑定游标 | tools/schema；SDK 客户端契约、业务错误、取消及长文分页测试 | 已验证 |
| 7.2 九个工具、部分/陈旧结果计数、导出使用同一任务模型 | tools/jobs/export；真实 stdio 闭环及批量计数、固定版本导出测试 | 已验证 |
| 7.3 外部发现与本地检索分开、严格账号/日期筛选 | 先 draft/filter 后提交；缺失字段不通过严格筛选；中文/混合词、账号/日期测试 | 已验证 |
| 7.4 可辨别任务输入、文章/候选/页数/时间上限及幂等冲突 | collectionSchema；页数是全部查询共用；重复/过滤/失败计数、准确耗尽、暂停恢复、幂等测试 | 已验证 |
| 7.5 条件账号工具 | 未配置经过验证的历史/账号解析来源；不注册条件工具，account 任务返回 UNSUPPORTED_CAPABILITY | 按方案条件范围处理 |
| 7.6 Resources/Prompts 可选，必要操作可用工具完成 | 九个工具覆盖必要操作；未增加任意路径资源接口 | 满足首期边界 |
| 8 URL→校验→HTTP/受控浏览器→解析→筛选→媒体→原子归档 | ArticleService/Store；真实 HTTP、浏览器兜底、单张真实图片下载及暂存筛选测试 | 已有真实和自动化证据 |
| 8 搜狗真实跳转与搜索闭环、候选 TTL、刷新/缓存 | 真实 stdio 与样本报告；签名链接支持、过期候选报错、失败刷新保留旧版测试 | 已实测；无全站召回保证 |
| 9 全部任务状态、逐项检查点、锁、停止后不后台运行、显式恢复 | JobRunner/Store；验证等待、中断、暂停/恢复/取消、stdio 退出和锁检查 | 已自动验证 |
| 9.3 最多 2 次重试、Retry-After、等待预算不足进入可恢复状态 | backoff 与 next_attempt_at；冷却超过预算不消耗全部运行时间、不允许提前恢复的测试 | 已验证 |
| 10.1 内部 ID 路径、原子文件/DB 提交、迁移与清洗快照 | storage/util/parser；中文路径、根目录限制、拒绝高版本 DB、冲突不覆盖原文件 | 已实现并有相关测试 |
| 10.2 中文子串、参数化 SQL、稳定排序和 search_mode | Store.search 和本地检索工具；中文、词组、混合数字、SQL 字面量、账号/日期测试 | 已验证 |
| 10.3 Markdown/JSONL/静态 HTML、相对媒体、独立清单与部分失败 | Exporter；三种导出、固定正文版本、缺失媒体不得标 complete 测试及真实导出文件 | 已验证 |
| 11 错误码及真实空搜索与来源错误分开 | WxError/failure；schema 校验交 SDK；搜索结构变化/验证/限流失败不转空数组 | 已实现并有异常测试 |
| 12 凭据不输出、固定命令、逐跳白名单、拒绝私网、目录边界、不执行文章指令 | HTTP DNS 校验；managed Chrome 的 DNS 固定 + CDP Fetch；真实浏览器本地陷阱验证直接/重定向/子资源/WS 零连接；MCP 不接受脚本/路径 | 已有真实浏览器约束证据 |
| 13 示例非敏感配置、忽略数据、绝对路径、硬上限、单会话串行 | config.example.json、.gitignore、配置 schema、BrowserSource/JobRunner；配置根目录与中文路径测试 | 已实现 |
| 14 分层项目结构 | server/tools/providers/browser/resolver/parser/jobs/storage/export/config/shared；检索封装于 Store，未为拟定目录名拆空模块 | 功能职责满足，目录允许调整 |
| 15.1 至少 20 篇人工确认可访问，覆盖所有指定样本类型 | data/sample-acceptance-report.json 仅为自动 DOM 对照；data/acceptance/review.html 提供冻结版本核对材料，所有确认项初始未勾选 | **按用户要求暂缓，未执行人工核对** |
| 15.2.1 至少 19/20 标题/账号/正文/时间人工一致 | review:verify 校验至少 20 篇可访问、95% 一致、样本类型覆盖；无合格人工提交文件 | **按用户要求暂缓，不宣称人工准确率通过** |
| 15.2.2–10 搜索/异常/幂等/恢复/筛选/检索/输出/运行/缓存 | 上述对应测试、真实 stdio/HTTP/浏览器/媒体报告；样本人工准确性不由绿色测试代替 | 已具对应证据；本轮复跑标准与 Chrome 检查通过 |
| 16 可安装项目、锁文件、配置/连接/验证说明、备份/恢复/导出、矩阵/限制/报告、许可 | README、配置与 package-lock、TOOL_CONTRACT、ARCHITECTURE、ACCEPTANCE_REPORT、THIRD_PARTY_NOTICES | 已交付；记录人工核对暂缓及实际验证范围 |

完成判定：按用户最新要求，本轮项目实现与验证交付完成。构建和 35 项标准检查通过，默认跳过的两个真实 Chrome 场景已另行运行通过；现存真实搜索到导出闭环报告、当前浏览器构建指纹及三种导出产物已复核。原方案人工样本验收暂缓，未执行、未代填；自动 DOM 对照不视作人工结果。以后恢复人工核对时，发现的差异仍需修复并复验。
