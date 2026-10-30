# 已实现工具契约

统一结果为 `schema_version=1.0`、`ok`、`request_id`，成功包含 `data`，需要时带 `coverage` 和 `warnings`；业务失败包含 `error` 并设置 MCP `isError=true`。SDK 校验输入/输出 schema。错误含 `code/message/retryable`，可带 `required_action/retry_after_seconds`。`CANCELLED` 是实现方案错误码之外增加的操作取消错误。

| 工具 | 主要输入 | data |
| --- | --- | --- |
| wx_status | check_sources=false | 版本、存储、浏览器连接、逐来源能力 |
| wx_search_articles | query, page=1（1–100）, limit=10（1–10）, provider=opencli_sogou | candidates：候选 ID、来源 URL、标题、摘要、时间原文，未核验元数据 |
| wx_fetch_article | url 或 candidate_id 二选一, refresh=false, download_images=false | article 元数据和状态、cache_hit、stale、last_attempt、fallback_reason |
| wx_read_article | article_id, content_version?, format=blocks/markdown/text, cursor?, max_chars? | 内容块或正文、references、has_more、next_cursor、max_chars |
| wx_search_library | query, account_id?, published_from?, published_before?, limit=10（1–50）, cursor? | articles、匹配片段、search_mode=substring、排序、next_cursor |
| wx_start_collection | input、下表策略、idempotency_key? | job_id、kind、state、config、counts、coverage |
| wx_get_job | job_id, failures_only=false, limit=20（1–100）, cursor? | 任务摘要、结果、分页 items、next_cursor |
| wx_control_job | job_id, action=pause/resume/cancel | 更新任务摘要 |
| wx_export_articles | article_ids（1–500）或 job_id 二选一, format=markdown/jsonl/html, include_media=false, idempotency_key? | kind=export 的任务摘要 |

默认正文上限 12000 字符，硬上限 50000，可通过配置降低。按整块分页，超过单页上限的块带 fragment_start/fragment_end/fragmented。游标绑定文章、正文版本、格式、长度，跨查询不能复用。引用格式为 `article_id + content_version + block_id`。

| 采集参数 | 默认 | 硬上限/语义 |
| --- | --- | --- |
| input.type=urls | — | urls 数组 1–1000，微信文章链接 |
| input.type=search | — | queries 数组 1–20，provider=opencli_sogou |
| input.type=account | — | 返回 UNSUPPORTED_CAPABILITY |
| max_articles | 50 | 500，合格完整/部分正文（含接受缓存）总量 |
| max_discovered | 200 | 1000，失败、重复、过滤也占检查量 |
| max_pages | 5 | 50，整个任务的全部查询共用此页数预算 |
| max_duration_seconds | 600 | 3600，累计运行/退避时间，不含暂停、人工等待和停机 |
| account_id/account_name | 无 | 正文核验后严格匹配 |
| published_from/published_before | 无 | 带时区 ISO 或上海日期，左闭右开 |
| require_complete | false | true 时部分正文仅诊断，不进入资料库 |
| refresh/download_images | false | 强制尝试刷新/通过筛选后下载图片 |

`counts` 包含 checked、accepted、success、partial、filtered、failed、duplicate、stale 各自的 `_count`。accepted=success+partial。stale 是交叉统计，不能与其他计数相加；强制刷新遇到可恢复来源/验证故障时保留旧正文并进入等待，旧缓存不计刷新成功。确定不可恢复的刷新失败可记 failed+stale。同任务按文章 ID 去重，不按内容哈希合并转载。

来源 ID `opencli_sogou` 与 `opencli_browser` 为兼容原契约而保留；默认实际后端是 `managed_chrome`。候选的 browser_backend、文章的 method 和 wx_status 的 browser/backend、指纹及网络自检诊断披露实际路径。旧 Bridge 后端仅支持诊断，不允许在缺少网络拦截时执行采集。

来源失败进入 waiting_source，认证/验证分别进入 waiting_auth/waiting_verification。可重试网络错误最多 2 次重试，退避优先采用 Retry-After。明确删除、权限错误不自动重试。终态不能 resume；暂停和等待状态显式 resume 后从检查点继续。发现来源状态目前为进程内缓存，重启后恢复 unverified。

Retry-After 超出剩余自动运行预算时保留 next_attempt_at 并进入 waiting_source，人工等待不计运行时间；冷却截止之前 resume 返回 RATE_LIMITED。恰好处理完全部显式 URL 时不因上限等于输入数量而虚报截断。签名规范链接无法取得可靠 sn 时附 canonical_url_may_expire，缓存正文仍可通过版本化 ID 阅读。

导出创建时固定版本。完成后的 `data.result` 含 export_id、manifest_path、files、failures、complete。有失败的导出 `complete=false`；JSONL 不嵌入二进制。相同幂等键和相同规范化输入返回原任务；不同参数返回 CONFLICT。键在采集和导出之间共享命名空间。

错误码：INVALID_INPUT、UNSUPPORTED_CAPABILITY、SOURCE_UNAVAILABLE、AUTH_REQUIRED、VERIFICATION_REQUIRED、RATE_LIMITED、ARTICLE_DELETED、ACCESS_RESTRICTED、PARSE_FAILED、NETWORK_ERROR、IDENTITY_AMBIGUOUS、RESOURCE_NOT_FOUND、CONFLICT、CANCELLED。参数/协议错误由 SDK 返回。
