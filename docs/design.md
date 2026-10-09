# 设计与机制

面向维护者的实现说明:插件如何挂进 dsh 的会话标题子系统,以及踩过的坑。

## 挂载点:唯一 provider

dsh 的标题子系统(`@deepseek-ai/dsh-session-title`)是一个日志驱动服务:

- 标题以 `session/title` 事件追加进会话日志,折叠取最新一条;回放、恢复、分页后仍然存在,**绝不进入模型输入**。
- 标题来源三种,最新者胜:确定性回退(首条合格人类消息的前几词)、已注册 provider 的生成结果、显式用户改名(`rename()`,会"钉住"会话)。
- provider 通过 `ctx.sessionTitle.register()` 注册,**注册表有意只接受一个**;第二次注册立即抛错。

因此本插件的存在形态是"替换":profile 层必须 `disabled: true` 停用内置的
`session-title-llm`(`@deepseek-ai/dsh-session-title-first-prompt-llm`),本插件的
`apply()` 再注册自己的 provider(id `session-title-ruled`)。

## 生成链路

`automatic: 'all-prompts'` 下,每条合格人类消息(`user/message`、source.kind=user、含非空文本)
都会调度一次生成(用户钉住的会话除外);pending 在主请求头落日志后启动,路由取自该头,
生成与主循环异步并行,失败只告警。

generate(request) 内部:

1. **编号例外**:`keepTitlePatterns`(默认 `^\d{2}｜`)命中现有标题即抛错放弃,保护
   `01｜MS Research` 类编号体系。
2. **日期**:`latestConversationStamp()` 倒序扫事件取最新 `user/message` 的 `time`,
   本地时区格式化为 MMDD;无则退到最后事件时间,再退当前时间。
3. **选消息**:`selectMessages()` 全量装得下就全量;超预算从最新向前装满(不再保首条,
   第一句不定死主题)。返回子集升序,满足服务对 `messageSeqs` 严格递增的校验。
4. **调用**:`ctx.llm.stream` 一次小请求;思考型模型先 `resolveModelInfo` 解析最低推理档
   (带 5s 竞速超时),空输出降级重试(最低档→无档位),再空取思考流尾段。
   超时用 `AbortSignal.timeout` 与调用方取消信号 `AbortSignal.any` 合并。
5. **解析**:`parseTypedTitle()` 容忍引号/代码围栏/ASCII 竖线/自带日期前缀/多余分段,
   类型必须命中八枚举,否则抛错保留旧标题,下次消息再试。
6. **回填**:宿主把 `MMDD｜类型｜名` 交给服务校验(UTF-8 安全截断、控制符清洗)后落
   `session/title` 事件。

## 双实例规避

插件不 import 任何 cordis / dsh-* 运行时包(它们由宿主提供,插件侧再 import 会形成
第二个 Service/Context 实例)。需要的两个小函数(`sessionTitle.register` 的调用契约、
llm 流式 chunk 协议)在插件内自带实现;倒序扫日志这类折叠逻辑同理手写。

## 坑:会话日志是逐帧 zstd

存量会话批量补名时踩过:文件物理结构是**逐帧 zstd**,宿主打开会话时强校验
"首帧恰好只含 header 行"。把全文解压重压成单帧,列表折叠(宽容路径)正常,
但打开会话(严格路径)报 `corrupt Zstandard session log`。正确做法是保留原字节,
把新增事件压成**独立帧追加**——这正是宿主自身追加事件的方式。
详见 `scripts/batch-rename/batchrename-apply.py` 的 `frame_bytes` 注释。

## 兼容性

- dsh `>=0.1.7-rc.2`(依赖 `ctx.sessionTitle` 注册表语义与 llm 流式 chunk 协议)。
- Node `>=20.3`(`AbortSignal.any` / `AbortSignal.timeout`)。
- 运行时依赖仅 `@deepseek-ai/schemastery`(Config schema);宿主侧由 loader 注入
  `sessionTitle` / `llm` 服务。
