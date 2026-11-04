# usage-guard

Claude Code 全局插件：实时监控当前账号的订阅用量（5 小时限额、7 天限额等），**任一窗口达到 93%（可配置）时自动拦截并停止所有任务**，提示你切换账号或等待额度恢复。

## 它会做什么

| 时机 | 行为 |
| --- | --- |
| 状态栏 | 一直显示 `🟢 用量 5h 24% · 7d 89%`；≥ 预警值变 🟡，触发拦截变 ⛔ |
| 低于阈值（平时） | **不弹任何窗**，只在状态栏显示用量；≥ 预警值（默认 85%）时状态栏变 🟡 |
| 回合进行中跨过阈值 | 立即中止正在运行的回合（含运行中的工具），在对话里留下说明，弹出提示和系统通知 |
| 拦截期间提交提示词 | 直接丢弃（用户输入、/loop、定时任务、后台通知都算），并显示原因与重置时间 |
| 拦截期间任何模型请求 | 不再发出（主线程、子代理、队友都算），以拦截说明结束回合 |
| 拦截期间工具调用 / 启动子代理 | 全部拒绝 |
| 在本会话或**任意其他会话** /login 切换账号后 | 被拦截的会话再发消息（或空闲轮询时）会发现换了账号，切到新账号并重新查询用量，新账号低于阈值立即放行 |
| 到达重置时间 | 自动放行 |
| 阈值附近 | 拦截后要降到「阈值 − 1」以下才放行，避免两个数据源（差 1% 左右）来回切换、反复弹窗 |

## 用量从哪里来

- 每次模型响应都带有账号限额信息，引擎读到后推送给插件（零额外请求，实时）；
- 会话启动、空闲轮询（默认 120 秒）、提交提示词时数据过旧，会用**当前会话自己的凭证**查询 `https://api.anthropic.com/api/oauth/usage`，凭证由 Claude Code 代为附加，插件拿不到明文。
- 换账号：Claude Code 把登录凭证缓存在每个会话的进程里，只在发模型请求前才重新读取；被拦截的会话不发请求，所以别的会话 `/login` 之后它仍拿着旧账号的凭证，查到的也是旧账号的用量。因此插件每次查询前会对比全局配置 `~/.claude.json` 里最近一次登录的账号（只读 `oauthAccount` 的 uuid 和邮箱）与本会话凭证所属的账号（`https://api.anthropic.com/api/oauth/profile`），不一致时发一个极小的模型请求（haiku，实测约 10 个输入、几十个输出 token），让 Claude Code 重新读取凭证、换上新账号，再查询新账号的用量。每次换号最多发一次；仍没换过去时会提示在本会话运行 `/login`，`/usage-guard` 可以再试一次。
- 不是 Claude 订阅登录（API Key、Bedrock/Vertex 等）或查询失败时**不拦截**（fail-open），插件出错也不会锁死会话。

## 网络与数据

- 插件只访问 `api.anthropic.com` 上的这两个地址（`/api/oauth/usage`、`/api/oauth/profile`），不连接任何第三方服务，**没有遥测或数据上报**。
- 插件平时不发起模型请求；只有发现其他会话换了账号时，才发上面那一个极小的请求（计入新账号的用量，可以忽略不计）。
- 本机只读一个文件：全局配置 `~/.claude.json`（设置了 `CLAUDE_CONFIG_DIR` 时读那个目录下的），只取 `oauthAccount` 的账号 uuid、组织 uuid 和邮箱，用来判断是否换了账号。
- 本机只保存一项数据：`/usage-guard pause` 设定的暂停截止时间（存在插件自己的存储里，所有会话共用）。
- `/api/oauth/usage` 和 `/api/oauth/profile` 不在公开文档里，以后可能变化。变化后查询会失败，插件按 fail-open 放行，模型响应里携带的限额信息照常生效（换账号的检测会跳过，此时在被拦截的会话里运行 `/login` 即可）。

## 命令

```
/usage-guard               查看当前用量、重置时间与拦截状态（会立即刷新）
/usage-guard pause 30      临时暂停拦截 30 分钟（所有会话生效，风险自负）
/usage-guard resume        提前恢复拦截
```

## 配置

在 `/config` 里找到 usage-guard 的三个选项，或在 `~/.claude/settings.json` 中：

```json
"pluginConfigs": {
  "usage-guard@jay6697117": { "options": { "threshold": 93, "warnAt": 85, "pollSeconds": 120 } }
}
```

- `threshold`：拦截阈值（%），默认 93
- `warnAt`：状态栏变黄的百分比，默认 85（不弹窗）
- `pollSeconds`：空闲轮询间隔（秒），默认 120，最小 30

## 安装 / 更新 / 卸载

仅适用于 Claude Code（插件用的是 hooks 模块，claude.ai 网页版和 Cowork 不加载）。在终端里：

```
claude plugin marketplace add jay6697117/usage-guard
claude plugin install usage-guard@jay6697117
```

更新：`claude plugin update usage-guard@jay6697117`。卸载：`claude plugin uninstall usage-guard@jay6697117`。

## 开发

```
git clone https://github.com/jay6697117/usage-guard
claude --plugin-dir ./usage-guard              # 只在这一次会话里加载本地副本
claude plugin validate --strict ./usage-guard
claude plugin test ./usage-guard               # tests/usage-guard.test.ts，22 个用例，不联网
```

## 许可证

MIT，见 [LICENSE](LICENSE)。
