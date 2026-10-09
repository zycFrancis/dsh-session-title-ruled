/**
 * dsh-session-title-ruled — 按 prompt-hub《跨 Agent 对话命名》规则自动命名 dsh 会话。
 *
 * 背景(为什么是插件而不是提示词规则):
 *  1. dsh 没有向 agent 暴露会话改名工具,规则里"用当前工具支持的标题接口改名"
 *     在 dsh 侧无接口可调;
 *  2. 内置 dsh-session-title-first-prompt-llm 的提示词写死为英文"自然语言标题",
 *     无法配置成 MMDD｜类型｜对话名 格式;
 *  3. ctx.sessionTitle.register() 是公开扩展点,且服务只允许一个 provider——
 *     本插件因此替换(而非叠加)内置 provider。
 *
 * 规则映射:
 *  - 格式 MMDD｜类型｜对话名,全角竖线分隔;日期取最近一次对话(user/message)的
 *    日期(本地时区),跨日续聊随之更新(2026-10-10 修订,原为创建日固定);
 *  - 类型八选一:研究/量化/开发/配置/排障/管理/创作/日常;
 *  - automatic: 'all-prompts' → 每条新用户消息后按"最近综合全部上下文的主题"
 *    重新分类命名,超预算时预算全部给最近消息,不由第一句定死;
 *  - 用户手动改名由服务自动"钉住"(source=user 后不再自动改),无需本插件处理;
 *  - dot 远程任务例外:现有标题匹配 keepTitlePatterns(默认两位编号前缀)时
 *    拒绝生成,保持 `01｜MS Research` 类编号体系不变。
 *
 * 实现约束:不导入 cordis/dsh-* 运行时包(避免与宿主双实例),只用 ctx API、
 * Node 内建与 schemastery(Config schema)。
 */

import s from '@deepseek-ai/schemastery'
import { appendFileSync, chmodSync } from 'node:fs'

/** provider id,会记入 session/title 事件的 source.provider。 */
const PROVIDER_ID = 'session-title-ruled'
const PACKAGE = 'dsh-session-title-ruled'

/** 规则规定的八个主类型(固定枚举,不得创造新词)。 */
export const TITLE_TYPES = [
  '研究', '量化', '开发', '配置', '排障', '管理', '创作', '日常',
]

/** 标题三段之间的全角竖线(U+FF5C);解析时也容忍 ASCII 竖线。 */
const SEPARATOR = '｜'

/**
 * 由会话创建时间(毫秒 epoch)得本地时区 MMDD。
 * 规则要求"按用户本地时区取对话开始日期",宿主进程时区即用户时区。
 * @param {number} createdAtMs - 会话创建时间。
 * @returns {string} 四位 MMDD,月日各补零。
 */
export function formatStamp(createdAtMs) {
  const date = new Date(Number.isFinite(createdAtMs) ? createdAtMs : Date.now())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${month}${day}`
}

/** 去掉模型输出常见的包裹:代码围栏、多余行;引号剥离下沉到分段处理。 */
function stripWrapping(raw) {
  let text = String(raw ?? '')
  // 只取第一行非空内容:提示词要求单行,多行时取首个实义行。
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  text = lines[0] ?? ''
  // 代码围栏:```foo``` 或 ``` 语法高亮标记。
  text = text.replace(/^```[a-zA-Z0-9_-]*\s*/, '').replace(/```\s*$/, '')
  return text.trim()
}

/** 剥掉单段两侧的引号(模型常给类型或名称单独加引号,如「管理」｜记忆整理)。 */
function stripQuotes(text) {
  return text.replace(/^[「『"'“”]+/, '').replace(/[」』"'“”]+$/, '').trim()
}

/**
 * 解析模型输出为 { type, name }。
 * 容忍:自作主张加的 MMDD 前缀、ASCII 竖线、名称中多出的竖线(合并为／)。
 * @param {string} raw - 模型原始输出。
 * @returns {{ type: string, name: string } | null} 无法解析或类型不在枚举时 null。
 */
export function parseTypedTitle(raw) {
  let text = stripWrapping(raw)
  if (text === '') return null
  // 模型无视指令自带日期前缀时剥掉,日期一律由宿主生成(保证准确)。
  text = text.replace(/^\d{4}[｜|]\s*/, '')
  // 统一 ASCII 竖线为全角,再按全角切分。
  text = text.replace(/\|/g, SEPARATOR)
  const parts = text.split(SEPARATOR).map((part) => stripQuotes(part)).filter((part) => part !== '')
  if (parts.length < 2) return null
  const type = parts[0]
  if (!TITLE_TYPES.includes(type)) return null
  // 名称里不应再含分隔符:剩余段合并为"段1／段2",信息不丢且不破坏三段格式。
  const name = parts.slice(1).join('／')
  if (name === '') return null
  return { type, name }
}

/**
 * 清洗并截断对话名:压空白、去首尾分隔符、按码点截断到上限。
 * @param {string} name - 原始名称。
 * @param {number} maxCharacters - 码点上限。
 * @returns {string} 清洗后的名称;可能为空串。
 */
export function normalizeName(name, maxCharacters) {
  let text = String(name ?? '').replace(/\s+/g, ' ').trim()
  text = text.replace(/^[-—:：、,，.。\s]+/, '').replace(/[-—:：、,，.。\s]+$/, '')
  // 名称内部不得出现分隔符,否则最终标题会变成四段。
  text = text.replace(/[｜|]/g, '／')
  const chars = Array.from(text)
  const truncated = chars.length > maxCharacters ? chars.slice(0, maxCharacters).join('') : text
  // 截断可能把新的标点/空格留到尾部,再清一次。
  return truncated.replace(/[-—:：、,，.。\s]+$/, '')
}

/**
 * 组装最终标题 MMDD｜类型｜对话名。
 * @param {string} stamp - 四位日期。
 * @param {string} type - 已验证的类型。
 * @param {string} name - 已清洗的名称。
 * @returns {string} 三段标题。
 */
export function buildRuledTitle(stamp, type, name) {
  return [stamp, type, name].join(SEPARATOR)
}

/**
 * 现有标题是否命中"保持不变"模式(dot 远程任务的编号体系)。
 * 模式是正则源字符串;非法正则忽略并记日志,不让一条坏配置拖垮命名。
 * @param {string | undefined} currentTitle - 当前已折叠标题。
 * @param {string[]} patterns - 正则源字符串列表。
 * @param {{ warn?: (message: string) => void }} [logger] - 可选告警出口。
 * @returns {boolean} 命中则 true。
 */
export function shouldKeepTitle(currentTitle, patterns, logger) {
  if (typeof currentTitle !== 'string' || currentTitle === '') return false
  for (const source of patterns) {
    let pattern
    try {
      pattern = new RegExp(source, 'u')
    } catch (error) {
      logger?.warn?.(`${PACKAGE}: invalid keepTitlePatterns entry ${JSON.stringify(source)}: ${String(error)}`)
      continue
    }
    if (pattern.test(currentTitle)) return true
  }
  return false
}

/**
 * 从事件数组倒序找最新 session/title 事件的标题(只读)。
 * 不导入 dsh-session-title 的 foldSessionTitle,避免与宿主双实例。
 * @param {Array<object>} events - 会话事件(时间序)。
 * @returns {string | undefined} 当前标题。
 */
function titleFromEvents(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') return event.data.title
  }
  return undefined
}

/**
 * 字节预算内截断单条超长文本(保尾部):排障场景首条消息常是整段粘贴的日志,
 * 尾部通常是最新的提问/结论。预算按 JSON 转义后的字节计——控制字符/引号的
 * 转义会让文本膨胀约 2 倍,按原文截会让 framed 输入超预算;转义后仍超时
 * 对半缩预算重截,最多三轮(病态输入封底)。
 */
function tailTruncate(text, maxBytes) {
  let budget = maxBytes
  let truncated = truncateUtf8Tail(text, budget)
  for (let round = 0; round < 3 && Buffer.byteLength(JSON.stringify(truncated), 'utf8') > maxBytes; round++) {
    budget = Math.floor(budget / 2)
    truncated = truncateUtf8Tail(text, budget)
  }
  return truncated
}

/** 码点安全的保尾截断:从末尾按码点累计 UTF-8 字节,不切断代理对。 */
function truncateUtf8Tail(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let used = 0
  const chars = Array.from(text)
  const kept = []
  for (let i = chars.length - 1; i >= 0; i--) {
    const bytes = Buffer.byteLength(chars[i], 'utf8')
    if (used + bytes > maxBytes) break
    kept.unshift(chars[i])
    used += bytes
  }
  return kept.join('')
}

/**
 * 选取进入标题生成的人类消息:整段塞不下时,预算全部给最近的消息。
 * 规则(2026-10-10 修订):标题反映"最近综合全部上下文的主题",不由第一句定死,
 * 因此不再强制保留首条;超预算时从最新向前装满为止。
 * 单条消息自身超预算时截尾保一条(而不是整条丢弃导致选择为空、
 * 会话永远停在回退标题)。
 * @param {Array<{ seq: number, text: string }>} messages - 全部合格消息(升序)。
 * @param {number} maxInputBytes - 框成 JSON 后的字节预算。
 * @returns {Array<{ seq: number, text: string }>} 选中子集(升序,至少含最新一条)。
 */
export function selectMessages(messages, maxInputBytes) {
  if (messages.length === 0) return []
  const itemBytes = (text) => Buffer.byteLength(JSON.stringify([{ text }]), 'utf8') + 1
  const allBytes = Buffer.byteLength(JSON.stringify(messages.map((message) => ({ text: message.text }))), 'utf8')
  if (allBytes <= maxInputBytes) return [...messages]
  // 从最新往前收集,再反转为升序:服务要求 messageSeqs 按请求顺序递增。
  const tail = []
  let used = 2
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = itemBytes(messages[i].text)
    if (used + cost > maxInputBytes) {
      if (tail.length === 0) {
        // 预算内连最新一条都装不下:截尾保一条(留出 JSON 外壳与转义余量)。
        const budget = Math.max(64, maxInputBytes - used - 32)
        tail.push({ seq: messages[i].seq, text: tailTruncate(messages[i].text, budget) })
      }
      break
    }
    tail.push(messages[i])
    used += cost
  }
  return tail.reverse()
}

/**
 * 最近对话日期:倒序找最新 user/message 事件的时间(本地时区 MMDD)。
 * 规则(2026-10-10 修订):日期跟随最近一次对话,跨日续聊随之更新;
 * 无 user/message 时退到最后一个事件的时间,再退 fallback。
 * @param {Array<{ type?: string, time?: number }>} events - 会话事件(时间序)。
 * @param {number} [fallbackMs] - 完全无事件时的兜底时间。
 * @returns {string} 四位 MMDD。
 */
export function latestConversationStamp(events, fallbackMs) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'user/message' && Number.isFinite(event.time)) return formatStamp(event.time)
  }
  const last = events.at(-1)
  if (last !== undefined && Number.isFinite(last.time)) return formatStamp(last.time)
  return formatStamp(fallbackMs)
}

/** 生成提示词:类型枚举 + 对话名要求 + 严格输出格式。 */
function systemInstruction(config) {
  return [
    '你负责为 AI 编程助手的工作会话起标题。输入是会话中人类消息的 JSON 数组(按时间顺序;会话很长时只保留最近的消息)。',
    '',
    '第一步,从下面八个类型中恰好选择一个主类型(按会话当前的主要目标分类;拿不准时选「日常」;不得创造新类型):',
    '研究:公司、行业、产品、技术调研',
    '量化:策略、回测、定价、交易分析',
    '开发:代码、工具、功能开发',
    '配置:安装、部署、模型接入、环境',
    '排障:报错、故障、恢复、修复',
    '管理:Agent 协作、规则、记忆、文件整理',
    '创作:文章、图片、PPT、音视频',
    '日常:普通知识问答、生活、闲聊、测试',
    '',
    `第二步,用消息的主要语言起一个简洁准确的对话名,约 ${config.targetCjkCharacters} 个汉字以内(英文则不超过 ${Math.max(3, Math.ceil(config.targetCjkCharacters / 2))} 个词);有助于辨识的项目名可以保留。`,
    '',
    '命名以最近的消息为主、综合提供的全部消息概括会话**当前**的主题;话题已经实质转变时,按转变后的主题分类命名,不要沿用开头的旧话题。',
    '',
    '只输出一行,格式严格为:类型｜对话名',
    '用全角竖线「｜」分隔;不要输出日期、引号、解释、Markdown 或代码。',
  ].join('\n')
}

/** 把选中消息框成 JSON,用户文本不能破坏结构分隔符。 */
function frameInput(selected) {
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(selected.map((message) => ({ text: message.text })))}`
}

/**
 * 解析模型的最低推理档:标题不需要思考,思考型模型不降档时小输出上限
 * 会被思考内容耗尽(max-tokens 截断,正文为空)。带 5s 超时防适配器挂起。
 * (做法与 dsh-prompt-suggestion 一致,已在实践中验证。)
 */
async function lowestReasoningEffort(llm, route, signal) {
  let info
  // 竞速 timer 用后即清:裸 setTimeout 会拖住进程优雅退出(实测差 3s)。
  let timer = undefined
  try {
    info = await Promise.race([
      llm.resolveModelInfo(route.provider, route.model, signal),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 5000, undefined)
        timer.unref?.()
      }),
    ])
  } catch { /* 模型信息不可用时按无 effort 裸调 */ } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  const efforts = info?.reasoning?.efforts
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined
  const off = efforts.find((effort) => /^(disable|disabled|none|off|minimal|lowest)$/i.test(effort.id))
  if (off !== undefined) return off.id
  const low = efforts.find((effort) => /^low(est)?$/i.test(effort.id))
  return low?.id ?? efforts[0].id
}

/** 思考流尾部提取(思考型模型正文为空时的兜底):取最后一非空段,超长保尾。 */
function tailOfReasoning(reasoning) {
  const trimmed = reasoning.trim()
  if (trimmed === '') return ''
  const parts = trimmed.split(/\n{2,}|\n/).map((part) => part.trim()).filter((part) => part !== '')
  const tail = parts.at(-1) ?? trimmed
  return tail.length > 240 ? tail.slice(-240) : tail
}

/**
 * 消费 llm.stream 并聚合文本;finish 非 stop 一律判失败。
 * @returns {Promise<{ text: string, reasoning: string }>}
 */
async function streamText(llm, options) {
  let text = ''
  let reasoning = ''
  let finish = null
  for await (const chunk of llm.stream(options)) {
    if (chunk === null || chunk === undefined) continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish === null || finish.kind !== 'stop') {
    const detail = finish?.failure?.message ?? (finish === null ? 'missing finish' : finish.kind)
    throw new Error(`title stream finished: ${String(detail)}`)
  }
  return { text, reasoning }
}

/** Loader 配置:provider/model 不设默认——未配置时跟随会话主请求路由,各 profile 可显式指定便宜小模型。 */
export const Config = s.object({
  provider: s.string(),
  model: s.string(),
  targetCjkCharacters: s.number().step(1).min(2).max(30).default(12),
  maxNameCharacters: s.number().step(1).min(4).max(40).default(16),
  maxInputBytes: s.number().step(1).min(1024).max(131072).default(8192),
  maxOutputTokens: s.number().step(1).min(16).max(4096).default(512),
  timeoutMs: s.number().step(1).min(1000).max(2147483647).default(45000),
  keepTitlePatterns: s.array(s.string()).default(['^\\d{2}｜']),
  debugLog: s.boolean().default(false),
})

/** 诊断日志:debugLog 开启时落 /tmp(0600,日志含模型原始输出片段,收紧本地读取面)。 */
let debugLogEnabled = false
function logNo(message) {
  if (!debugLogEnabled) return
  try {
    const file = '/tmp/dsh-session-title-ruled.log'
    appendFileSync(file, `${new Date().toISOString()} [${PACKAGE}] ${message}\n`, { mode: 0o600 })
    // mode 只对新建文件生效:兼容旧版本遗留的 0644 日志。
    chmodSync(file, 0o600)
  } catch { /* /tmp 不可写时静默 */ }
}

/** 服务要求的 inject:sessionTitle 是注册目标,llm 是生成依赖。 */
export const inject = ['sessionTitle', 'llm']

/**
 * 挂载:向 ctx.sessionTitle 注册唯一 provider。
 * 内置 session-title-llm 必须已在 profile 层停用,否则这里的 register 会抛错
 * (一个服务只允许一个 provider),dsh 启动日志会直接暴露冲突。
 */
export function apply(ctx, config = {}) {
  // 归一化:loader 正规路径会经 Config 填默认值;这里再过一遍,使绕过 loader 的
  // 直接调用(测试/脚本)拿到同样的默认语义,而不是 undefined 炸在超时/模式上。
  const cfg = Config(config)
  debugLogEnabled = cfg.debugLog === true
  const configured = typeof cfg.provider === 'string' && cfg.provider !== ''
    && typeof cfg.model === 'string' && cfg.model !== ''
  const dispose = ctx.sessionTitle.register({
    id: PROVIDER_ID,
    // all-prompts:每条新用户消息都可触发重命名,主题演进时类型与对话名随之更新;
    // 日期取最近一次对话(user/message)的日期,跨日续聊随之更新。
    automatic: 'all-prompts',
    async generate(request) {
      const { session, messages, signal } = request
      if (!Array.isArray(messages) || messages.length === 0) throw new Error('no eligible human messages')

      // 一次快照两处复用(现有标题 + 最近对话日期);快照不可用时按空事件处理,
      // 日期兜底链:最后事件时间 → header.createdAt → 当前时间。
      let events = []
      try {
        events = session.snapshotEvents?.() ?? []
      } catch { /* 快照抛错不炸整个生成 */ }

      // dot 远程任务例外:编号标题(如 01｜MS Research)保持不变,不重排、不改格式。
      const current = titleFromEvents(events)
      if (shouldKeepTitle(current, cfg.keepTitlePatterns, ctx.logger)) {
        logNo(`keep "${current}" (matches keepTitlePatterns)`)
        throw new Error(`title kept: "${current}" matches keepTitlePatterns`)
      }

      const stamp = latestConversationStamp(events, session.header?.createdAt)
      const selected = selectMessages(messages, cfg.maxInputBytes)
      if (selected.length === 0) throw new Error('message selection is empty')

      // 路由:显式配置优先;否则跟随会话主请求路由(pending 只在请求头落日志后启动,route 必在)。
      const route = configured
        ? { provider: cfg.provider, model: cfg.model }
        : request.route
      if (route === undefined) throw new Error('no route: configure provider/model or wait for the session request header')
      // 标题请求是高频小请求:始终用最低推理档,不继承会话主请求的思考档。
      const effort = await lowestReasoningEffort(ctx.llm, route, signal)
      signal.throwIfAborted()

      // 超时按流式调用独立计时(首调 + 空输出降级重试各自一个完整窗口);
      // 与调用方取消信号合并。AbortSignal.any/timeout 需要 Node >= 20.3。
      const makeOptions = (withEffort) => ({
        provider: route.provider,
        model: route.model,
        system: systemInstruction(cfg),
        messages: [{
          id: `str-${session.id}-${selected.at(-1).seq}`,
          role: 'user',
          content: [{ type: 'text', text: frameInput(selected) }],
          source: { kind: PACKAGE },
        }],
        maxTokens: cfg.maxOutputTokens,
        ...(withEffort && effort !== undefined ? { reasoningEffort: effort } : {}),
        sessionId: session.id,
        purpose: 'session-title',
        signal: AbortSignal.any([signal, AbortSignal.timeout(cfg.timeoutMs)]),
      })

      logNo(`generating via ${route.provider}/${route.model}${effort !== undefined ? ` effort=${effort}` : ''} for ${session.id.slice(0, 12)} (${selected.length}/${messages.length} messages, stamp=${stamp})`)
      let streamed = await streamText(ctx.llm, makeOptions(true))
      // 空输出降级:最低档仍空 → 完全不带档位(与 dsh-prompt-suggestion 相同的阶梯)。
      if (streamed.text.trim() === '' && streamed.reasoning.trim() === '' && effort !== undefined) {
        logNo('empty output; retrying without effort')
        streamed = await streamText(ctx.llm, makeOptions(false))
      }
      const raw = streamed.text.trim() !== '' ? streamed.text : tailOfReasoning(streamed.reasoning)

      const parsed = parseTypedTitle(raw)
      if (parsed === null) {
        logNo(`unparseable output: ${JSON.stringify(String(raw).slice(0, 160))}`)
        throw new Error(`title model output is not 类型｜对话名: ${JSON.stringify(String(raw).slice(0, 80))}`)
      }
      const name = normalizeName(parsed.name, cfg.maxNameCharacters)
      if (name === '') throw new Error('title name normalizes to empty')

      const title = buildRuledTitle(stamp, parsed.type, name)
      logNo(`accepted "${title}" (raw=${JSON.stringify(String(raw).slice(0, 120))})`)
      return {
        title,
        messageSeqs: selected.map((message) => message.seq),
        model: { provider: route.provider, model: route.model },
      }
    },
  })
  ctx.logger?.info?.(`[${PACKAGE}] provider registered (route=${configured ? `${cfg.provider}/${cfg.model}` : 'session-route'}, automatic=all-prompts)`)
  return dispose
}
