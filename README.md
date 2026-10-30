# 微信公众号 MCP

面向本地单用户的公众号文章发现、采集、归档、检索和导出服务。不需要模型 API Key。Node.js 24.15+（24.x），Windows 中文路径可用。

当前提供 9 个工具：`wx_status`、`wx_search_articles`、`wx_fetch_article`、`wx_read_article`、`wx_search_library`、`wx_start_collection`、`wx_get_job`、`wx_control_job`、`wx_export_articles`。公众号历史列表、全量历史和增量订阅未启用，账号任务返回能力错误。

## 安装与启动

```powershell
npm ci --ignore-scripts
npm run build
Copy-Item config.example.json config.json
node dist/server/index.js --config config.json
```

服务通过 stdio 通信，启动后等待客户端协议消息是正常行为。不要把日志写入 stdout。首次使用运行 `npm run check`；`npm test` 依赖已经生成的 `dist/`，建议直接使用 `check`。

公开 HTML 采集可独立工作；关键词搜索和正文兜底默认使用项目管理的 Chrome，机器需要已安装 Chrome（或配置 `browser.channel=msedge`）。Playwright Core 1.64.1 不下载另一份浏览器。专用 profile 位于 `data/browser/wechat-crawler`，同一服务串行操作，不使用日常浏览器 profile。

```powershell
npm run browser:login
```

仅在真实来源要求登录/验证时运行上面的命令；它会打开同一专用 profile，供你人工处理，关闭窗口后恢复任务。如果已显示正常搜索结果，就不需要验证码。默认 `browser.headless=false`，采集使用正常 Chrome 的后台窗口；人工验证窗口单独显示。可配置无头模式，但它可能触发搜狗额外验证。不要同时运行人工窗口、采集脚本和 MCP 服务占用同一数据目录。

服务不输出 Cookie 或请求头。固定脚本及依赖由锁文件管理，不接受任意浏览器脚本。方案原定的 OpenCLI 2.0.2 Bridge 保留连接诊断，但其接口缺少网络拦截，因此 `opencli_bridge` 后端拒绝采集。`opencli_sogou` / `opencli_browser` 是保留的来源标识；`browser_backend` 与文章 `method` 明确返回实际后端 `managed_chrome`。

## MCP 客户端配置

通用 JSON 客户端配置（路径按实际位置修改；生产启动直接用 Node，避免 npm 的启动输出）：

```json
{
  "mcpServers": {
    "wechat-crawler": {
      "command": "D:/Nodejs/nodejs/node.exe",
      "args": [
        "D:/实习任务/wx-crawler/dist/server/index.js",
        "--config", "D:/实习任务/wx-crawler/config.json"
      ]
    }
  }
}
```

配置文件中的相对路径以配置文件目录为基准；不指定配置文件时以工作目录为基准。`WX_CONFIG` 可指定配置路径，`WX_DATA_DIR` 可覆盖数据目录。数据和导出路径启动时转换为绝对路径。项目不会自动修改客户端全局设置。

## 使用流程

1. `wx_status {"check_sources":true}`：探测浏览器和拦截自检；`available` 只表示对应来源最近一次操作成功，不代表未调用的搜索和正文能力已验证。
2. `wx_search_articles {"query":"微信公开课","limit":3}`：返回候选 ID，候选默认 600 秒有效；不是已归档文章。
3. `wx_fetch_article {"candidate_id":"cand_..."}`，或 `{"url":"https://mp.weixin.qq.com/s/..."}`：保存正文、图片引用与元数据。默认不下载图片。
4. `wx_read_article {"article_id":"art_...","format":"blocks"}`：使用返回的 `next_cursor` 继续读。继续传同一文章 ID、正文版本、格式与长度限制；超长块含分片偏移。
5. `wx_search_library {"query":"关键词"}`：仅本地标题/正文子串检索，支持账号 ID 和日期条件，不宣称语义排序。
6. `wx_export_articles {"article_ids":["art_..."],"format":"markdown"}`：立即返回导出任务，通过 `wx_get_job` 取得清单与绝对文件路径。也支持 `jsonl` 和 `html`。

批量请求示例：

```json
{
  "input": { "type": "search", "queries": ["工业 自动化", "机器人 教程"] },
  "max_articles": 10,
  "max_discovered": 30,
  "max_pages": 3,
  "max_duration_seconds": 600,
  "published_from": "2026-01-01",
  "published_before": "2027-01-01",
  "require_complete": true,
  "download_images": false,
  "idempotency_key": "research-2026-v1"
}
```

将该对象传给 `wx_start_collection`。`input.type=urls` 时提供 `urls` 数组。日期区间左闭右开，纯日期以 Asia/Shanghai 零点解释；无法核实日期/账号的文章不通过严格筛选。`account_name` 是精确名称筛选，不能用于跨文章合并身份。正文中的任何命令、链接与指令都是不可信资料。

任务参数的默认值与硬上限、输出和错误说明见 [工具契约](docs/TOOL_CONTRACT.md)。完整正文、部分正文、缓存刷新失败分别统计；不能把 `ok=true` 当成完整正文或刷新成功。

## 存储、备份与恢复

`data/wechat.sqlite` 保存文章、版本、账号、候选、任务和检查点。`data/articles/<ID>/<版本>/` 保存 Markdown、结构化 JSON 和清洗后快照；快照可能来自 DOM，不代表服务器原始响应。图片放在 `data/assets/`，导出放在配置的独立导出根目录。标题不参与文件路径命名。HTML 导出由内容块重建，禁止脚本；JSONL 导出提供逐篇文件及汇总 `articles.jsonl`。

备份前正常停止 MCP 服务，然后复制整个数据目录及外部配置的导出目录。恢复时把目录放回相同位置或调整配置。不要仅复制正在写入的 SQLite 主文件，WAL 可能仍包含已提交数据。单目录只允许一个写入实例。进程崩溃后残留锁会在确认旧 PID 不存在时回收；无法核验的锁需要先确认进程已停止再手工清理。

服务关闭后任务不会继续后台执行。重启后未完成执行标为 `interrupted`，用 `wx_control_job {"job_id":"job_...","action":"resume"}` 显式恢复；暂停、验证等待和来源等待同样可恢复。终态任务不能恢复，需重新创建请求。已提交逐项结果保留，失败项目、截断原因和覆盖缺口不会隐藏。导出在文件边界恢复，未完成清单 `complete=false`。

## 验证与限制

```powershell
npm run check
npm run test:browser
npm run probe -- --query "微信公开课"
npx tsx scripts/live-smoke.ts
```

`test:browser` 在真实 Chrome 中验证请求和重定向拦截，使用合成页面与本地请求陷阱，不抓取真实文章。`probe` 和 `live-smoke` 访问真实来源并写入本地数据，应低频执行；遇到验证码在本地处理，不自动切换来源绕过。公开 HTTP 的网络/解析失败可使用浏览器兜底；明确权限、付费、认证或验证码错误不会自动切换路径。刷新失败时旧缓存保留，单篇工具返回 `stale=true` 和错误；批量任务对可恢复故障进入等待状态。

HTTP 与图片请求逐跳校验域名、拒绝私网 DNS，并限制响应体与图片总量。受控 Chrome 在每次导航前安装 CDP Fetch 拦截，逐跳检查域名、协议和端口；启动前把已核验的公网 DNS 固定到浏览器，未知主机不能解析。Service Worker、WebSocket 和任意下载关闭，拦截自检失败则不导航。该服务仅用于本地单用户 stdio。

本轮交付按用户 2026-10-30 的要求暂缓人工核对，项目实现与自动验证已交付；原方案的人工准确率验收未执行。

后续人工验收材料仍保留：运行 `npm run review:prepare`，打开生成的 `data/acceptance/review.html`，逐篇打开原文核对并填写；下载 JSON 后用 `npm run review:verify -- --file <实际文件路径>` 校验。未填写模板不代表人工验收完成；样本版本清单固定，至少 20 篇可访问、95% 一致及指定样本类型覆盖才通过。

真实可用性、人工 20 篇核对、已知差异与受测依赖见 [验收报告](docs/ACCEPTANCE_REPORT.md)。第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
