# Changelog

## 0.1.0 (2026-10-10)

- 首版：注册 `ctx.sessionTitle` 唯一 provider（`automatic: 'all-prompts'`），
  按 `MMDD｜类型｜对话名` 生成标题；类型八选一，日期取会话创建日。
- 路由策略：显式配置优先，否则跟随会话主请求路由；思考型模型自动降最低推理档。
- dot 远程任务例外：`keepTitlePatterns`（默认两位编号前缀）命中的现有标题保持不变。
- 输入超限时保首条 + 尽量多的最新消息（升序，满足服务 messageSeqs 校验）。
- 纯逻辑单测 10 例；同版本 runtime 端到端实测通过。
