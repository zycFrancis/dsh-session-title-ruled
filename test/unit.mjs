/** 纯逻辑单元测试:node --test test/unit.mjs(不触碰宿主与网络)。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TITLE_TYPES,
  formatStamp,
  parseTypedTitle,
  normalizeName,
  buildRuledTitle,
  shouldKeepTitle,
  selectMessages,
} from '../lib/index.js'

test('formatStamp 按本地时区补零', () => {
  // new Date(年, 月-1, 日) 按本地时区构造,避开时区差异。
  assert.equal(formatStamp(new Date(2026, 0, 7).getTime()), '0107')
  assert.equal(formatStamp(new Date(2026, 10, 21).getTime()), '1121')
  assert.equal(formatStamp(new Date(2026, 11, 1).getTime()), '1201')
  // 非法输入退化为当前时间,不抛错(标题生成不应因日期崩掉)。
  assert.match(formatStamp(undefined), /^\d{4}$/)
})

test('parseTypedTitle 解析标准输出', () => {
  assert.deepEqual(parseTypedTitle('开发｜dsh 会话命名插件'), { type: '开发', name: 'dsh 会话命名插件' })
  assert.deepEqual(parseTypedTitle(' 量化｜回测年化计算  '), { type: '量化', name: '回测年化计算' })
})

test('parseTypedTitle 容忍 ASCII 竖线与自带日期前缀', () => {
  assert.deepEqual(parseTypedTitle('排障|端口占用排查'), { type: '排障', name: '端口占用排查' })
  assert.deepEqual(parseTypedTitle('0107｜配置｜接入 GLM 路由'), { type: '配置', name: '接入 GLM 路由' })
})

test('parseTypedTitle 剥代码围栏与引号、取首行', () => {
  assert.deepEqual(parseTypedTitle('```开发｜插件调试```'), { type: '开发', name: '插件调试' })
  assert.deepEqual(parseTypedTitle('「管理」｜记忆整理'), { type: '管理', name: '记忆整理' })
  assert.deepEqual(parseTypedTitle('日常｜闲聊\n多余的第二行'), { type: '日常', name: '闲聊' })
})

test('parseTypedTitle 名称含多余竖线时合并', () => {
  assert.deepEqual(parseTypedTitle('研究｜台积电｜先进制程'), { type: '研究', name: '台积电／先进制程' })
})

test('parseTypedTitle 非法输入返回 null', () => {
  assert.equal(parseTypedTitle('物理｜黑洞 entropy'), null)
  assert.equal(parseTypedTitle('没有分隔符的标题'), null)
  assert.equal(parseTypedTitle(''), null)
  assert.equal(parseTypedTitle('｜开发｜'), null)
  assert.equal(parseTypedTitle(undefined), null)
})

test('normalizeName 压空白、去首尾标点、按码点截断', () => {
  assert.equal(normalizeName('  dsh   插件 ', 16), 'dsh 插件')
  assert.equal(normalizeName('、调试插件。', 16), '调试插件')
  assert.equal(normalizeName('a｜b', 16), 'a／b')
  // emoji 按码点计数,不切断代理对。
  assert.equal(normalizeName('x🎉🎉🎉🎉', 3), 'x🎉🎉')
})

test('buildRuledTitle 输出三段全角竖线格式', () => {
  assert.equal(buildRuledTitle('0107', '开发', '会话命名插件'), '0107｜开发｜会话命名插件')
  assert.equal(TITLE_TYPES.length, 8)
})

test('shouldKeepTitle 保留 dot 编号标题、放过规则格式', () => {
  const patterns = ['^\\d{2}｜']
  assert.equal(shouldKeepTitle('01｜MS Research', patterns), true)
  assert.equal(shouldKeepTitle('04｜Derivatives Research', patterns), true)
  assert.equal(shouldKeepTitle('0107｜开发｜会话命名插件', patterns), false)
  assert.equal(shouldKeepTitle(undefined, patterns), false)
  assert.equal(shouldKeepTitle('', patterns), false)
  // 非法正则忽略,不抛错。
  const warnings = []
  assert.equal(shouldKeepTitle('01｜MS Research', ['[unclosed'], { warn: (m) => warnings.push(m) }), false)
  assert.equal(warnings.length, 1)
})

test('selectMessages 预算内全量、超预算保首条加最新', () => {
  const messages = (texts) => texts.map((text, index) => ({ seq: index, text }))
  const small = messages(['帮我调试', '还是不行', '再看看'])
  assert.deepEqual(selectMessages(small, 8192), small)

  const big = messages(['第一条', ...Array.from({ length: 200 }, (_, i) => `消息内容 ${i}`)])
  const selected = selectMessages(big, 600)
  // 首条保留,尾部按预算截取,整体升序。
  assert.equal(selected[0].text, '第一条')
  assert.deepEqual([...selected].sort((a, b) => a.seq - b.seq), selected)
  assert.ok(selected.at(-1).seq > selected[1].seq)
  const framed = JSON.stringify(selected.map((message) => ({ text: message.text })))
  assert.ok(Buffer.byteLength(framed, 'utf8') <= 600 + 200)
  assert.deepEqual(selectMessages([], 100), [])
})
