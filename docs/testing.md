# 测试安全模式

存储事故(见 [store-safety.md](store-safety.md))之后,任何涉及会话存储/宿主重启的测试都应按下表分级。核心原则:**dsh 尊重 `DSH_HOME` 环境变量**——profiles、sessions、storages 全部随之搬家,这是天然的全量沙箱边界。

| 级别 | 场景 | 隔离度 | 验证状态 |
|---|---|---|---|
| L1 | `DSH_HOME` 沙箱 + headless 一次对话 | 完全隔离(真实库零接触) | 已实测(见下) |
| L2 | `DSH_HOME` 沙箱 + 桌面 app | 完全隔离 | 同一环境变量机制,未实启第二个 GUI 实例 |
| L3 | 真实库 + 快照与体检门禁 | 不隔离,但有回滚网 | 快照/体检均实测 |

## L1:命令行沙箱(推荐首选)

```bash
bash scripts/sandbox-demo.sh "测试提示"     # 一条命令完成:建沙箱→对话→验证零接触
bash scripts/store-check.sh                 # 顺手体检真实库(只读,应输出 异常 0)
rm -rf /tmp/dsh-sandbox                     # 测完整个沙箱一删即净
```

脚本自带红线:沙箱路径指向真实 `~/.dsh` 时直接拒绝执行。已实测:真实存储文件数前后一致(零接触),沙箱会话落点 slug 与 header.cwd 一致。注意:沙箱内 LLM 需要 `ZAI_CODING_CN_API_KEY` 在环境中,取不到时标题停在 fallback(隔离性结论不受影响)。

## L2:桌面 app 安全模式

1. 正常退出 DSH Desktop(单实例锁,必须先退);
2. 终端执行:`DSH_HOME=$HOME/.dsh-sandbox open -a "DSH Desktop"`;
3. 在这个实例里随便测——所有会话/凭据/缓存都写在 `~/.dsh-sandbox`;
4. 测完退出,删掉 `~/.dsh-sandbox`,正常方式重开 app。

限制:凭据不随沙箱走,需要在沙箱实例的 Models 页重新存一次;未实测双实例行为,故要求先退真实实例。

## L3:真实库测试(最后手段)

```bash
bash scripts/store-check.sh                          # 前置体检,异常 0 才继续
tar czf ~/dsh-sessions-backup-$(date +%m%d%H%M).tgz -C ~ .dsh/sessions
# …执行被测操作/重启…
bash scripts/store-check.sh                          # 后置体检
# 出问题:退出 app,解包快照覆盖 ~/.dsh/sessions
```
