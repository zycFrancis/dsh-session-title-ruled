/** apply()/generate() 的 mock 集成测试:node --test test/harness.mjs(不发网络请求)。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject } from '../lib/index.js'

/** 造一次可脚本化的 llm:behaviors 是每次 stream 调用的产出(异步 chunk 数组)。 */
function fakeLlm(behaviors, effortInfo) {
  const calls = []
  return {
    calls,
    async resolveModelInfo() {
      return effortInfo
    },
    async *stream(options) {
      calls.push(options)
      const behavior = behaviors[Math.min(calls.length - 1, behaviors.length - 1)]
      if (behavior instanceof Error) throw behavior
      yield* behavior
    },
  }
}

const chunks = (...items) => items
const text = (value) => ({ type: 'text-delta', text: value })
const think = (value) => ({ type: 'reasoning-delta', text: value })
const stop = () => ({ type: 'finish', reason: { kind: 'stop' } })

/** 造一个最小会话对象:事件数组驱动(时间序)。 */
function fakeSession(events, createdAt) {
  return {
    id: 'session-test-0001',
    header: { createdAt },
    snapshotEvents: () => events,
  }
}

const day = (n) => new Date(2026, 9, n).getTime()
/** 合格 user/message 事件。 */
const userMsg = (seq, when, body) => ({
  type: 'user/message',
  seq,
  time: when,
  data: { source: { kind: 'user' }, content: [{ type: 'text', text: body }] },
})
const titleEvent = (seq, when, title) => ({
  type: 'session/title',
  seq,
  time: when,
  data: { title, source: { kind: 'fallback' } },
})

/** 注册捕获 + 可编程 ctx。 */
function harness(llm) {
  let registered
  const ctx = {
    llm,
    logger: { info() {}, warn() {} },
    sessionTitle: {
      register(provider) {
        if (registered !== undefined) throw new Error('already registered')
        registered = provider
        return () => {}
      },
    },
  }
  return {
    ctx,
    provider: () => {
      assert.ok(registered !== undefined, 'provider 未注册')
      return registered
    },
  }
}

/** 通用请求骨架。 */
const request = (session, messages, route) => ({
  session,
  messages,
  route,
  signal: new AbortController().signal,
})

test('apply 注册 provider,inject 声明 sessionTitle 与 llm', async () => {
  const { ctx, provider } = harness(fakeLlm([]))
  const dispose = apply(ctx, { provider: 'p', model: 'm' })
  assert.equal(typeof dispose, 'function')
  assert.equal(provider().id, 'session-title-ruled')
  assert.equal(provider().automatic, 'all-prompts')
  assert.deepEqual(inject, ['sessionTitle', 'llm'])
})

test('happy path:标题/日期/messageSeqs/路由回填,空 config 走默认值', async () => {
  const llm = fakeLlm([chunks(text('开发｜dsh 插件测试'), stop())], { reasoning: { efforts: [{ id: 'high' }, { id: 'low' }] } })
  const { ctx, provider } = harness(llm)
  apply(ctx, {}) // 空 config:Config 归一化后默认值生效
  const session = fakeSession([userMsg(8, day(9), '帮我调试插件')], day(9))
  const result = await provider().generate(request(session, [{ seq: 8, text: '帮我调试插件' }], { provider: 'zai', model: 'flash' }))
  assert.equal(result.title, '1009｜开发｜dsh 插件测试')
  assert.deepEqual(result.messageSeqs, [8])
  // 未配置路由时跟随 request.route
  assert.deepEqual(result.model, { provider: 'zai', model: 'flash' })
  // 首次调用带最低推理档
  assert.equal(llm.calls[0].reasoningEffort, 'low')
  assert.equal(llm.calls[0].purpose, 'session-title')
})

test('路由:显式配置优先于 request.route', async () => {
  const llm = fakeLlm([chunks(text('日常｜闲聊'), stop())], undefined)
  const { ctx, provider } = harness(llm)
  apply(ctx, { provider: 'cfg-prov', model: 'cfg-model' })
  const session = fakeSession([userMsg(3, day(10), 'hi')], day(10))
  const result = await provider().generate(request(session, [{ seq: 3, text: 'hi' }], { provider: 'req-prov', model: 'req-model' }))
  assert.deepEqual(result.model, { provider: 'cfg-prov', model: 'cfg-model' })
  assert.equal(llm.calls[0].provider, 'cfg-prov')
})

test('keepTitlePatterns 命中编号标题:放弃且不发起 LLM 调用', async () => {
  const llm = fakeLlm([chunks(text('研究｜不该出现'), stop())])
  const { ctx, provider } = harness(llm)
  apply(ctx, {})
  const session = fakeSession([
    userMsg(8, day(9), '旧消息'),
    titleEvent(9, day(9), '01｜MS Research'),
  ], day(9))
  await assert.rejects(
    () => provider().generate(request(session, [{ seq: 8, text: '旧消息' }])),
    /matches keepTitlePatterns/,
  )
  assert.equal(llm.calls.length, 0)
})

test('无路由且未配置 provider/model:抛错', async () => {
  const { ctx, provider } = harness(fakeLlm([]))
  apply(ctx, {})
  const session = fakeSession([userMsg(8, day(9), 'x')], day(9))
  await assert.rejects(
    () => provider().generate(request(session, [{ seq: 8, text: 'x' }], undefined)),
    /no route/,
  )
})

test('finish 非 stop:抛错放弃', async () => {
  const llm = fakeLlm([chunks(text('开发｜x'), { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } })])
  const { ctx, provider } = harness(llm)
  apply(ctx, { provider: 'p', model: 'm' })
  const session = fakeSession([userMsg(8, day(9), 'x')], day(9))
  await assert.rejects(
    () => provider().generate(request(session, [{ seq: 8, text: 'x' }])),
    /title stream finished: boom/,
  )
})

test('空输出降级:首调空(带最低档)→重试不带档位→成功', async () => {
  const llm = fakeLlm([
    chunks(stop()),
    chunks(text('排障｜端口占用'), stop()),
  ], { reasoning: { efforts: [{ id: 'low' }] } })
  const { ctx, provider } = harness(llm)
  apply(ctx, { provider: 'p', model: 'm' })
  const session = fakeSession([userMsg(8, day(9), '端口占用')], day(9))
  const result = await provider().generate(request(session, [{ seq: 8, text: '端口占用' }]))
  assert.equal(result.title, '1009｜排障｜端口占用')
  assert.equal(llm.calls.length, 2)
  assert.equal(llm.calls[0].reasoningEffort, 'low')
  assert.equal('reasoningEffort' in llm.calls[1], false)
  // 首调与降级重试各自独立超时窗口。
  assert.notEqual(llm.calls[0].signal, llm.calls[1].signal)
})

test('正文空而思考非空:取思考流尾段解析', async () => {
  const llm = fakeLlm([chunks(think('先想一想标题……\n再确认一下格式\n\n配置｜接入路由'), stop())], undefined)
  const { ctx, provider } = harness(llm)
  apply(ctx, { provider: 'p', model: 'm' })
  const session = fakeSession([userMsg(8, day(9), '接入')], day(9))
  const result = await provider().generate(request(session, [{ seq: 8, text: '接入' }]))
  assert.equal(result.title, '1009｜配置｜接入路由')
})

test('输出不可解析:抛错保留旧标题语义', async () => {
  const llm = fakeLlm([chunks(text('没有分隔符'), stop())], undefined)
  const { ctx, provider } = harness(llm)
  apply(ctx, { provider: 'p', model: 'm' })
  const session = fakeSession([userMsg(8, day(9), 'x')], day(9))
  await assert.rejects(
    () => provider().generate(request(session, [{ seq: 8, text: 'x' }])),
    /is not 类型｜对话名/,
  )
})

test('日期:取最新 user/message,而非会话创建日', async () => {
  const llm = fakeLlm([chunks(text('量化｜因子检验'), stop())], undefined)
  const { ctx, provider } = harness(llm)
  apply(ctx, { provider: 'p', model: 'm' })
  const session = fakeSession([
    userMsg(8, day(1), '十月一日的问题'),
    userMsg(20, day(12), '十二月…不对,十月十二的问题'),
  ], day(1))
  const result = await provider().generate(request(session, [
    { seq: 8, text: '十月一日的问题' },
    { seq: 20, text: '十月十二的问题' },
  ]))
  assert.equal(result.title, '1012｜量化｜因子检验')
  assert.deepEqual(result.messageSeqs, [8, 20])
})

test('快照抛错不炸生成:日期退到 header.createdAt', async () => {
  const llm = fakeLlm([chunks(text('管理｜记忆整理'), stop())], undefined)
  const { ctx, provider } = harness(llm)
  apply(ctx, { provider: 'p', model: 'm' })
  const session = {
    id: 'session-test-0002',
    header: { createdAt: day(3) },
    snapshotEvents() {
      throw new Error('snapshot unavailable')
    },
  }
  const result = await provider().generate(request(session, [{ seq: 8, text: '整理记忆' }]))
  assert.equal(result.title, '1003｜管理｜记忆整理')
})

test('单条消息超预算:截尾保一条而不是选择为空', async () => {
  const llm = fakeLlm([chunks(text('排障｜长日志报错分析'), stop())], undefined)
  const { ctx, provider } = harness(llm)
  apply(ctx, { provider: 'p', model: 'm', maxInputBytes: 1024 })
  const huge = '报错日志\n' + 'x'.repeat(20000) + '\n尾部是真正的提问:帮我分析这个崩溃'
  const session = fakeSession([userMsg(8, day(9), huge)], day(9))
  const result = await provider().generate(request(session, [{ seq: 8, text: huge }]))
  assert.equal(result.title, '1009｜排障｜长日志报错分析')
  assert.deepEqual(result.messageSeqs, [8])
  // 送入的文本被截到预算内,且保住了尾部提问。
  const sent = llm.calls[0].messages[0].content[0].text
  assert.ok(Buffer.byteLength(sent, 'utf8') < 1400)
  assert.ok(sent.includes('帮我分析这个崩溃'))
})
