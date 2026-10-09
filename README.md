# dsh-session-title-ruled

[English](README.en.md) | 中文

按固定规则为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 会话自动生成标题：

```
MMDD｜类型｜对话名
```

- **MMDD**：最近一次对话的日期（最新 `user/message` 事件时间，宿主本地时区），跨日续聊随之更新到最新对话当天。
- **类型**：八选一——研究 / 量化 / 开发 / 配置 / 排障 / 管理 / 创作 / 日常。
- **对话名**：由一次小 LLM 请求生成，以最近消息为主、综合全部上下文概括**当前**主题；话题实质转变后类型与名称随之更新，不由第一句定死。

类型枚举与格式来自作者的跨 Agent 命名规则（中文固定枚举），适合有同样命名习惯的用户；类型词本身是中文，不随消息语言翻译。

## 为什么是插件

1. dsh 未向 agent 暴露会话改名工具，"让模型自己改名"在 dsh 侧无接口可调；
2. 内置 `dsh-session-title-first-prompt-llm` 的提示词固定为英文"自然语言标题"，无法配置成结构化格式；
3. `ctx.sessionTitle.register()` 是公开扩展点，且服务只允许一个 provider——本插件**替换**（而非叠加）内置 provider。

## 安装

> 前提：`dsh-session-title` 服务只允许注册一个 provider。启用本插件必须同时停用内置的 `session-title-llm` 条目，否则插件的 `register()` 会在启动时报 "already registered"。

### 1. 安装包（任选其一）

```bash
# 从 GitHub(git 规格)
dsh plugin --profile <profile> add zycFrancis/dsh-session-title-ruled

# 或本地路径
dsh plugin --profile <profile> add /absolute/path/to/dsh-session-title-ruled
```

也可以用 Web UI 侧边栏的**插件**页或 `plugin_manager` 工具安装。

### 2. 在 profile 的 `cordis.patch.yml` 追加

```yaml
# 停用内置自然语言标题提供方(必须:一个服务只允许一个 provider)
- id: session-title-llm
  disabled: true
# 路由示例:显式指定便宜小模型;不配则跟随会话主请求路由
- id: session-title-ruled
  config:
    provider: zai-coding-cn
    model: glm-5.3-flash
```

### 3. 重启该 profile 的宿主

desktop / web profile 由各自 app 掌管，重启后生效。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` / `model` | 未设 | 标题小请求的路由；建议显式指定便宜小模型，不设则跟随会话主请求路由 |
| `targetCjkCharacters` | 12 | 提示词中对话名的汉字目标长度 |
| `maxNameCharacters` | 16 | 对话名硬上限（码点截断） |
| `maxInputBytes` | 8192 | 框成 JSON 后的输入字节预算；超预算时从最新向前装满为止 |
| `maxOutputTokens` | 512 | 标题请求输出上限（思考型模型降档后仍需余量） |
| `timeoutMs` | 45000 | 单次标题请求超时 |
| `keepTitlePatterns` | `['^\\d{2}｜']` | 现有标题命中任一正则则拒绝重命名（保护 `01｜MS Research` 类编号体系） |
| `debugLog` | false | 落 `/tmp/dsh-session-title-ruled.log` 便于排查 |

## 行为细节

- `automatic: 'all-prompts'`：每条新用户消息后按最近综合主题更新标题；日期跟随最近一次对话。
- 用户在 UI 手动改名后，`dsh-session-title` 服务会"钉住"该标题（source=user），本插件自动让位。
- 思考型模型自动解析最低推理档；空输出时降级重试（最低档 → 无档位），再空则取思考流尾段。
- 生成失败只告警不阻塞：会话保留确定性回退标题（首条消息前几个词）。
- 标题绝不进入模型输入（`dsh-session-title` 既有保证），对主请求 token / KV cache 零影响。
- 实现不导入 cordis / dsh-* 运行时包（避免与宿主双实例），只用 ctx API、Node 内建与 schemastery。

## 排查

- 启动日志搜 `session-title-ruled provider registered`；冲突会直接抛 `already registered`（内置 provider 未停用）。
- `debugLog: true` 后看 `/tmp/dsh-session-title-ruled.log`（generating / accepted / keep / unparseable 四类行）。
- 标题不更新：确认会话未被手动改名钉住、标题未命中 `keepTitlePatterns`、路由模型可用。

## 开发

```bash
pnpm install
npm test        # 纯逻辑单测(日期、解析、截断、编号例外、消息选择)
```

- 设计与机制说明见 [docs/design.md](docs/design.md)。
- 仓库另含作者自用的存量会话批量补名脚本（`scripts/batch-rename/`，不入 npm 包），用法与安全边界见其 [README](scripts/batch-rename/README.md)。

## License

MIT
