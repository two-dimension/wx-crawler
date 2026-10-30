# 第三方依赖与参考

运行依赖由 package-lock.json 锁定，未复制上游业务适配器源代码。分发 node_modules 时须保留各包原有 LICENSE/NOTICE。此项目不把第三方许可证重新授权给用户。

Apache 依赖声明另保存在 [OpenCLI LICENSE](docs/licenses/OpenCLI-LICENSE.txt)、[Playwright LICENSE](docs/licenses/Playwright-LICENSE.txt) 和 [Playwright NOTICE](docs/licenses/Playwright-NOTICE.txt)。其余依赖许可随安装包保留。

| 依赖 | 版本 | 许可证（以安装包声明为准） | 用途 |
| --- | --- | --- | --- |
| @jackwener/opencli | 2.0.2 | Apache-2.0 | 旧 Bridge 连接诊断及初期参考 |
| playwright-core | 1.64.1 | Apache-2.0 | 受控 Chrome profile 与 CDP Fetch 网络拦截 |
| @modelcontextprotocol/sdk | 1.32.2 | MIT | MCP stdio 服务端与测试客户端 |
| cheerio | 1.2.0 | MIT | HTML 解析、清洗 |
| turndown | 7.2.2 | MIT | Markdown 转换 |
| zod | 4.6.7 | MIT | 参数和输出 schema |
| undici | 7.30.1（override） | MIT | OpenCLI/cheerio 间接依赖，统一安全补丁版本 |

Node 内置 SQLite 随 Node 发行，无第三方原生 SQLite 安装步骤。开发工具 TypeScript、tsx、@types/node、@types/turndown 的许可证保留在各安装包中。`npm ci --ignore-scripts` 避免 OpenCLI 安装脚本下载额外适配器；运行期不加载用户适配器。

设计参考来自 [OpenCLI](https://github.com/jackwener/OpenCLI)、[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) 及实现方案所列项目。未引入已停止维护的公众号历史接口。测试 fixture 为项目自造合成内容；真实文章只保存在被忽略的本地 data 目录，未纳入测试分发。
