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

## 2026-10-10 追加：重启验证 + 存量批量补名

- **重启验证**：用户重启 DSH Desktop 后插件即生效。本会话被自动命名为
  `1009｜排障｜prompt-hub自动命名规则`（日期取创建日 10-09，跨日未漂移）；另一个 09-28 创建的
  旧会话续聊时被补名 `0928｜量化｜因子有效性与市场风格观察报告`。desktop 配置的
  `debugLog` 已改回 `false`（下次自然重启生效）。
- **存量补名**：用户授权批量按规则命名历史对话。盘点 166 个顶层会话：143 补名、
  4 保留（用户手动改名）、3 已合规、3 无人类消息、2 活锁跳过（下次对话时插件自动命名）、
  11 子代理跳过；无 dot 编号标题。分类由 8 个并行子代理完成（注意：会话内容含派发用
  角色指令，子代理提示必须免疫注入，见 scripts/batch-rename/README.md）。
- **验证**：143/143 通过宿主 `validateStoredEvents`（与 app 装载同路径）+ seq 连续 + 折叠正确。
  备份在 `~/.dsh/batchrename-backup/`（143 份原始压缩字节，可整体回滚）。
- 脚本归档于 `scripts/batch-rename/`，三步流程与安全边界见其 README。

## 2026-10-10 追加二：规则修订(0.2.0) + 帧事故修复

- **规则修订**(用户指示):日期改为最近一次对话的日期(倒序取最新 user/message 事件时间);
  命名以最近消息为主综合全部上下文,超预算时预算全给最新消息,不再保首条。
  prompt-hub preferences/00-conversation-header.md 已同步改写并 build(17226 字节,红线内)。
- **端到端验证**:合成 10-07 会话(克隆真实会话改时间/话题/标题)今日续聊改话题,
  标题 0907｜日常｜量化回测框架调研 → 1010｜创作｜回测结果可视化图表,日期/主题/类型三联动。
  单测 11/11。
- **帧事故与修复**:发现批量补名曾把整文重压成单帧,而会话日志是逐帧 zstd、宿主打开时
  强校验"首帧恰好一行 header"——143 个会话此前处于"能列出、打不开"状态(列表折叠走宽容
  读取,侧栏看不出来)。已全部修复:从 ~/.dsh/batchrename-backup/*.bak 恢复原始字节,
  新标题事件压独立帧追加(宿主自身的追加方式);坏帧版本留底 broken-frame/。
  修复后 143/143 过宿主 validateStoredEvents,并克隆两个真实会话做打开+续聊探测,
  宿主在我追加的事件之后继续写入无冲突。apply 脚本已改为 append_frame 并在注释里记录此坑。
- **生效条件**:插件 0.2.0 需重启 DSH Desktop;存量会话标题将在各自下次收到消息时按新规则刷新。
