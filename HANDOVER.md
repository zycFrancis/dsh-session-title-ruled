# HANDOVER — dsh-session-title-ruled

唯一交接入口：本文件记录插件的事实、状态与下一步。

## 本轮做了什么（2026-10-10）

- **起因**：prompt-hub《跨 Agent 对话命名》规则在 dsh 不生效。排查结论：
  1) dsh 未向 agent 暴露会话改名工具；2) 内置 `dsh-session-title-first-prompt-llm`
  提示词固定为英文自然语言标题，无法配置成规则格式；3) `ctx.sessionTitle.register()`
  是公开扩展点且只允许一个 provider。→ 走插件路线。
- **实现**：`lib/index.js` 注册 `session-title-ruled` provider（`automatic: 'all-prompts'`），
  标题 `MMDD｜类型｜对话名`；日期取 `session.header.createdAt`（本地时区）；
  类型枚举八选一；输入超限保首条+最新；思考型模型降最低推理档，空输出降级重试；
  `keepTitlePatterns`（默认 `^\d{2}｜`）保护 dot 编号标题；不导入 cordis/dsh-* 运行时包。
- **接线**：
  - `~/.dsh/profiles/desktop/`：package.json 加依赖与 bundle；cordis.patch.yml 停用
    `session-title-llm`，`session-title-ruled` 配 `zai-coding-cn/glm-5.3-flash` + `debugLog: true`。
  - `~/.dsh/profiles/web/`：同上但未配 provider/model（该 profile 无 zai provider，跟随会话路由）。
  - headless profile **未接入**（该 profile 无 zai provider 配置；如需接入照 README 两步操作）。
- **验证**：
  - 单测 `npm test` 10/10 通过（抓出并修复了消息选择降序 bug——服务要求 messageSeqs 升序）。
  - 端到端：一次性 profile（dsh 0.1.7-rc.2，zai flash）跑真实会话，session log 落
    `{"type":"session/title",...,"title":"1010｜日常｜一句话解释复利","source":{"kind":"provider","provider":"session-title-ruled",...}}`。
    测试 profile 已删除。

## 当前状态

- 插件代码完成、测试通过、desktop/web profile 已接线，**等 DSH Desktop 重启后生效**
  （desktop profile 归 Electron app 掌管，进程内无法热换 provider；本会话内 plugin_manager
  热加载调用未成功发出）。web profile 下次 `dsh web` 启动即生效。
- desktop 配置里 `debugLog: true` 是为了首轮观察；确认第一条自动标题正确后建议改回 `false`。

## 已知限制 / 下一步

- 子代理会话同样会被命名（all-prompts 不区分 parentSession）；flash 路由下成本可忽略，
  如需跳过可在 generate 里判 `session.header.parentSession`。
- `keepTitlePatterns` 只按现有标题前缀判断 dot 编号体系；若 dot 会话先被 fallback 命名
  再被本插件接管，首次仍会重命名（编号标题一旦存在即受保护）。
- 观察 `/tmp/dsh-session-title-ruled.log`（desktop）与 app 日志里的
  `session-title-ruled provider registered` 确认装载。
- 未做 git 仓库初始化（周边 dsh-prompt-suggestion 有独立仓库，用户未要求）。
