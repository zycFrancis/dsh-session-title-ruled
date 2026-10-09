# dsh-session-title-ruled

按 [prompt-hub《跨 Agent 对话命名》](https://github.com/) 规则为 dsh 会话自动生成标题：

```
MMDD｜类型｜对话名
```

- **MMDD**：最近一次对话的日期（最新 `user/message` 事件时间，宿主本地时区），跨日续聊随之更新到最新对话当天。
- **类型**：八选一——研究 / 量化 / 开发 / 配置 / 排障 / 管理 / 创作 / 日常。
- **对话名**：由小 LLM 请求按人类消息生成，以最近消息为主、综合全部上下文概括当前主题；超预算时预算全部给最新消息，不由第一句定死。

## 为什么是插件

1. dsh 未向 agent 暴露会话改名工具，规则里"用当前工具支持的标题接口改名"在 dsh 无接口可调；
2. 内置 `dsh-session-title-first-prompt-llm` 的提示词固定为英文"自然语言标题"，无法配置成规则格式；
3. `ctx.sessionTitle.register()` 是公开扩展点，且服务只允许一个 provider——本插件**替换**内置 provider。

## 安装（profile 接线）

`dsh-session-title` 服务只允许注册一个 provider，启用本插件必须同时停用内置的
`session-title-llm`。以 desktop profile 为例：

1. `package.json`：`dependencies` 加 `"dsh-session-title-ruled": "link:/Users/zyc/code/dsh-session-title-ruled"`，
   `dsh.profile.bundles` 追加 `"dsh-session-title-ruled"`，然后在 profile 目录 `pnpm install`；
2. `cordis.patch.yml` 追加：

   ```yaml
   - id: session-title-llm
     disabled: true
   - id: session-title-ruled
     config:
       provider: zai-coding-cn      # 可选；不配则跟随会话主请求路由
       model: glm-5.3-flash
   ```

3. 重启该 profile 的宿主（desktop/web profile 由各自 app 掌管）。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` / `model` | 未设 | 标题小请求的路由；建议显式指定便宜小模型（如 glm-5.3-flash），不设则跟随会话主路由 |
| `targetCjkCharacters` | 12 | 提示词中对话名的汉字目标长度 |
| `maxNameCharacters` | 16 | 对话名硬上限（码点截断） |
| `maxInputBytes` | 8192 | 框成 JSON 后的输入字节预算；超限时从最新向前装满为止 |
| `maxOutputTokens` | 512 | 标题请求输出上限（思考型模型降档后仍需余量） |
| `timeoutMs` | 45000 | 单次标题请求超时 |
| `keepTitlePatterns` | `['^\\d{2}｜']` | 现有标题命中任一正则则拒绝重命名（dot 远程任务的 `01｜MS Research` 编号体系保持不变） |
| `debugLog` | false | 落 `/tmp/dsh-session-title-ruled.log` 便于排查 |

## 行为细节

- `automatic: 'all-prompts'`：每条新用户消息后按最近综合主题更新类型与对话名，日期跟随最近一次对话。
- 用户在 UI 手动改名后，`dsh-session-title` 服务会"钉住"该标题（source=user），本插件自动让位。
- 思考型模型自动解析最低推理档；空输出时降级重试（最低档 → 无档位），再空则取思考流尾段。
- 生成失败只告警不阻塞：会话保留确定性回退标题（首条消息前几个词）。
- 标题绝不进入模型输入（dsh-session-title 既有保证），对主请求 token / KV cache 零影响。

## 测试

```bash
npm test          # 纯逻辑单测（日期、解析、截断、编号例外、消息选择）
```

端到端（同版本 runtime 实测）：新会话首条消息"用一句话解释什么是复利"→
会话日志落入 `session/title` 事件 `1010｜日常｜一句话解释复利`，
source 为 `provider: session-title-ruled` + 模型路由。
