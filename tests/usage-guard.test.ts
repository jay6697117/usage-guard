import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { keyOfProfile, loginOfConfig, over, parseUsageResponse } from '../hooks/usage'

const NOW = Date.parse('2026-11-04T05:00:00Z')
const FIVE_RESET = '2026-11-04T06:20:00.019716+00:00'
const SEVEN_RESET = '2026-11-06T20:00:00.019740+00:00'

/** 用量接口真实返回的结构（截取）。 */
const body = (five: number, seven: number): unknown => ({
  five_hour: { utilization: five, resets_at: FIVE_RESET, limit_dollars: null, locked_reason: null },
  seven_day: { utilization: seven, resets_at: SEVEN_RESET, limit_dollars: null, locked_reason: null },
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false, monthly_limit: null, utilization: null },
  limits: [
    { kind: 'session', group: 'session', percent: five, resets_at: FIVE_RESET, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: seven, resets_at: SEVEN_RESET, is_active: true },
  ],
  spend: { percent: 0, severity: 'normal' },
})

type Figures = {
  /** 账号 A 的用量 */
  five: number
  seven: number
  /** 其他账号的用量 */
  other: { five: number; seven: number }
  /** 全局配置里最近一次 /login 的账号（任何会话登录都会改它）；undefined = 读不到 */
  disk: string | undefined
  /** 本会话引擎缓存着的 token 属于哪个账号 */
  token: string
  /** 引擎发请求前会不会重新读取凭证、换上 disk 的账号 */
  rereads: boolean
  isUp: boolean
  isSubscription: boolean
  fetches: number
  profiles: number
  completes: number
  modelCalls: number
  toasts: string[]
  statuses: (string | undefined)[]
  aborted: string[]
}

/** 插件之下的“引擎”：用量接口、时钟、存储、界面，全部在内存里。 */
function world(on: On, five: number, seven: number) {
  const f: Figures = {
    five,
    seven,
    other: { five: 3, seven: 5 },
    disk: 'acct-a',
    token: 'acct-a',
    rereads: true,
    isUp: true,
    isSubscription: true,
    fetches: 0,
    profiles: 0,
    completes: 0,
    modelCalls: 0,
    toasts: [],
    statuses: [],
    aborted: [],
  }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const session = mock.session(on)
  on('session.authorize', () => ({ value: f.isSubscription ? { handle: 'h', kind: 'bearer' as const } : null }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.read', (_, e) => {
    if (e.path !== '/home/u/.claude.json' || f.disk === undefined) throw new Error(`ENOENT: ${e.path}`)
    const oauthAccount = { accountUuid: f.disk, organizationUuid: 'org-1', emailAddress: `${f.disk}@example.com` }
    return { value: JSON.stringify({ numStartups: 3, oauthAccount }) }
  })
  on('http.fetch', (_, e) => {
    if (!f.isUp) return { value: { status: 503, ok: false, headers: {}, text: '' } }
    if (e.url.endsWith('/api/oauth/profile')) {
      f.profiles += 1
      const profile = { account: { uuid: f.token, email: `${f.token}@example.com` }, organization: { uuid: 'org-1' } }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(profile) } }
    }
    f.fetches += 1
    const u = f.token === 'acct-a' ? { five: f.five, seven: f.seven } : f.other
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body(u.five, u.seven)) } }
  })
  on('model.complete', () => {
    f.completes += 1
    if (f.rereads && f.disk !== undefined) f.token = f.disk // 引擎发请求前重新读取凭证
    const usage = { input_tokens: 8, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: { isAnswered: true as const, text: 'o', usage } }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('ui.toast', (_, e) => {
    f.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    f.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: false as const, reason: 'no-surface' as const } }))
  on('turn.abort', (_, e) => {
    f.aborted.push(e.turnId)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  on('turn.step', async function* (_, e) {
    f.modelCalls += 1
    yield { kind: 'text' as const, index: 0, text: 'model says hi' }
    return { turnId: e.turnId, index: e.index, answer: 'model says hi', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return { f, clock, session }
}

async function start($: Engine, clock: MockClock): Promise<void> {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(1) // 会话启动后的首次查询
}

const submit = ($: Engine, text = 'hi') => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

const bash = ($: Engine) => $.tool.call({ tool: 'Bash', command: 'ls' })

async function step($: Engine, turnId = 't1') {
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  const chunks: unknown[] = []
  let next = await stream.next()
  while (next.done !== true) {
    chunks.push(next.value)
    next = await stream.next()
  }
  return { chunks, result: next.value }
}

const command = ($: Engine, args: string) =>
  $.command.run({
    command: 'usage-guard',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

const dropOf = (r: { drop?: string }): string | undefined => r.drop

// ---------------------------------------------------------------- 纯逻辑

test('解析用量接口的返回', () => {
  const ws = parseUsageResponse(body(11, 87), NOW)
  expect(ws.map(w => [w.kind, w.percent])).toEqual([
    ['five_hour', 11],
    ['seven_day', 87],
  ])
  expect(over(ws, 93, NOW)).toEqual([])
  expect(over(parseUsageResponse(body(11, 95), NOW), 93, NOW).map(w => w.kind)).toEqual(['seven_day'])
})

test('只有 limits 列表时也能读出窗口', () => {
  const ws = parseUsageResponse(
    {
      limits: [
        { kind: 'session', percent: 50, resets_at: FIVE_RESET },
        { kind: 'weekly_all', percent: 94, resets_at: SEVEN_RESET },
      ],
    },
    NOW,
  )
  expect(ws.map(w => [w.kind, w.percent])).toEqual([
    ['five_hour', 50],
    ['seven_day', 94],
  ])
})

test('重置时间已过的窗口不再计入', () => {
  const ws = parseUsageResponse(body(99, 10), NOW)
  expect(over(ws, 93, NOW).map(w => w.kind)).toEqual(['five_hour'])
  expect(over(ws, 93, Date.parse(FIVE_RESET) + 1)).toEqual([])
})

test('从全局配置和 profile 接口读出同一写法的账号', () => {
  const cfg = { oauthAccount: { accountUuid: 'u1', organizationUuid: 'o1', emailAddress: 'a@b.c' } }
  expect(loginOfConfig(cfg)).toEqual({ key: 'u1/o1', label: 'a@b.c' })
  expect(keyOfProfile({ account: { uuid: 'u1' }, organization: { uuid: 'o1' } })).toBe('u1/o1')
  expect(loginOfConfig({ oauthAccount: { accountUuid: 'u1' } })).toEqual({ key: 'u1/', label: '另一个账号' })
  expect(loginOfConfig({})).toBeUndefined()
  expect(keyOfProfile({ error: 'x' })).toBeUndefined()
})

// ---------------------------------------------------------------- 拦截

test('低于阈值时一切照常，不弹任何提示，只在状态栏变黄', async ($, on) => {
  const { f, clock } = world(on, 11, 87)
  await start($, clock)
  expect(f.fetches).toBe(1)

  expect(dropOf(await submit($))).toBeUndefined()
  expect((await bash($)).deny).toBeUndefined()
  await step($)
  expect(f.modelCalls).toBe(1)

  expect(f.toasts).toEqual([])
  expect(f.statuses.at(-1)).toBe('🟡 用量 5h 11% · 7d 87%')
})

test('每条消息的响应头都带来略有不同的限额时，平时也不弹窗', async ($, on) => {
  const { f, clock } = world(on, 11, 90)
  await start($, clock)
  for (let i = 0; i < 5; i += 1) {
    expect(dropOf(await submit($))).toBeUndefined()
    await $.session.measure({
      context: { window: 200_000 },
      // 响应头的重置时间每次都差几秒、百分比和用量接口差 1
      rateLimits: [{ kind: 'seven_day', percentUsed: 89 + (i % 2), resetsAt: new Date(Date.parse(SEVEN_RESET) + i * 1_000).toISOString() }],
      changed: ['rateLimits'],
    })
    await step($)
    await clock.advance(60_000)
  }
  expect(f.toasts).toEqual([])
})

test('阈值附近两个数据源来回跳时，只弹一次拦截提示，不反复放行', async ($, on) => {
  const { f, clock } = world(on, 11, 93)
  await start($, clock)
  await $.turn.start({ text: 'go', turnId: 'main-1' })
  for (const p of [92.4, 93, 92.6, 93]) {
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [{ kind: 'seven_day', percentUsed: p, resetsAt: SEVEN_RESET }],
      changed: ['rateLimits'],
    })
    await clock.settle()
    expect((await bash($)).deny).toContain('usage-guard')
  }
  expect(f.toasts.filter(t => t.startsWith('⛔')).length).toBe(1)
  expect(f.toasts.some(t => t.includes('拦截已解除'))).toBe(false)
  expect(f.aborted).toEqual([])  // 回合开始前就已在拦截，不重复中止

  // 真正降下来（切换账号 / 重置）才放行
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 40, resetsAt: SEVEN_RESET }],
    changed: ['rateLimits'],
  })
  await clock.settle()
  expect((await bash($)).deny).toBeUndefined()
  expect(f.toasts.some(t => t.includes('拦截已解除'))).toBe(true)
})

test('达到 93% 时拦截提示词、模型请求和工具调用', async ($, on) => {
  const { f, clock } = world(on, 11, 95)
  await start($, clock)

  const drop = dropOf(await submit($))
  expect(drop).toContain('已达到 93% 拦截阈值')
  expect(drop).toContain('7 天总限额 已用 95%')
  expect(drop).toContain('/login')
  expect(drop).not.toContain('\n') // 丢弃理由只显示一行

  expect((await bash($)).deny).toContain('usage-guard')

  const { result } = await step($)
  expect(f.modelCalls).toBe(0)
  expect(result.answer).toContain('⛔ usage-guard')
  expect(result.toolUses).toEqual([])

  expect(f.statuses.at(-1)).toContain('已拦截')
  expect(f.toasts.some(t => t.startsWith('⛔'))).toBe(true)
})

test('/usage-guard 本身在拦截时仍可使用', async ($, on) => {
  const { clock } = world(on, 11, 95)
  await start($, clock)
  const r = await $.prompt.submit({
    text: '/usage-guard',
    wait: false,
    origin: { kind: 'composer' },
    command: { name: 'usage-guard', args: '' },
  })
  expect(dropOf(r)).toBeUndefined()
  const out = await command($, '')
  expect(out.text).toContain('⛔ 正在拦截')
  expect(out.text).toContain('7 天总限额：95%')
})

test('pause 暂停后放行，到期或 resume 后恢复拦截', async ($, on) => {
  const { clock } = world(on, 11, 95)
  await start($, clock)

  expect((await command($, 'pause 10')).text).toContain('已暂停拦截 10 分钟')
  expect(dropOf(await submit($))).toBeUndefined()
  expect((await bash($)).deny).toBeUndefined()

  await clock.advance(11 * 60_000)
  expect(dropOf(await submit($))).toContain('拦截阈值')

  await command($, 'pause')
  expect(dropOf(await submit($))).toBeUndefined()
  expect((await command($, 'resume')).text).toContain('已恢复拦截')
  expect(dropOf(await submit($))).toContain('拦截阈值')
})

test('回合进行中跨过阈值：立即中止主回合并留下通知', async ($, on) => {
  const { f, clock, session } = world(on, 11, 90)
  await start($, clock)
  await $.turn.start({ text: 'go', turnId: 'main-1' })

  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 93.4, resetsAt: SEVEN_RESET }],
    changed: ['rateLimits'],
  })
  await clock.settle()

  expect(f.aborted).toEqual(['main-1'])
  const notes = session.appended().map(row => JSON.stringify(row.message))
  expect(notes.some(n => n.includes('已自动停止所有任务'))).toBe(true)
  expect((await $.tool.call({ tool: 'Read', file_path: '/x' })).deny).toContain('7 天总限额 93.4%')
})

test('子代理的工具调用同样被拒绝', async ($, on) => {
  const { clock } = world(on, 11, 96)
  await start($, clock)
  const r = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })
  expect(r.deny).toContain('usage-guard')
})

test('切换到用量低的账号后立即放行', async ($, on) => {
  const { f, clock } = world(on, 11, 95)
  await start($, clock)
  expect(dropOf(await submit($))).toBeDefined()

  f.seven = 5 // /login 到另一个账号
  await clock.advance(3_000)
  expect(dropOf(await submit($))).toBeUndefined()
  expect(f.toasts.some(t => t.includes('拦截已解除'))).toBe(true)
})

test('到了重置时间自动放行，即使用量接口不可用', async ($, on) => {
  const { f, clock } = world(on, 95, 50)
  await start($, clock)
  expect(dropOf(await submit($))).toContain('5 小时限额 已用 95%')

  f.isUp = false
  await clock.set(Date.parse(FIVE_RESET) + 1_000)
  expect(dropOf(await submit($))).toBeUndefined()
})

test('拿不到用量（非订阅登录）时不拦截', async ($, on) => {
  const { f, clock } = world(on, 99, 99)
  f.isSubscription = false
  await start($, clock)
  expect(dropOf(await submit($))).toBeUndefined()
  expect((await bash($)).deny).toBeUndefined()
  expect(f.fetches).toBe(0)
})

test('选项可以改阈值', { options: { threshold: 80 } }, async ($, on) => {
  const { clock } = world(on, 11, 85)
  await start($, clock)
  expect(dropOf(await submit($))).toContain('已达到 80% 拦截阈值')
})

// ---------------------------------------------------------------- 在其他会话换账号

test('在其他会话 /login 换号后，被拦截的会话再发消息即放行', async ($, on) => {
  const { f, clock } = world(on, 11, 95)
  await start($, clock)
  expect(f.completes).toBe(0) // 账号一致时不发请求
  expect(dropOf(await submit($))).toContain('拦截阈值')

  f.disk = 'acct-b' // 另一个会话 /login 到 B；本会话的引擎仍缓存着 A 的 token
  await clock.advance(3_000)
  expect(dropOf(await submit($))).toBeUndefined()
  expect(f.completes).toBe(1)
  expect(f.token).toBe('acct-b')
  expect(f.toasts.some(t => t.includes('拦截已解除'))).toBe(true)
  expect((await bash($)).deny).toBeUndefined()

  // 换过去以后不再重复发请求
  await clock.advance(60_000)
  expect(dropOf(await submit($))).toBeUndefined()
  expect(f.completes).toBe(1)
})

test('在其他会话换号后，被拦截的会话空闲时也会自动解除', async ($, on) => {
  const { f, clock } = world(on, 11, 95)
  await start($, clock)
  expect(f.statuses.at(-1)).toContain('已拦截')

  f.disk = 'acct-b'
  await clock.advance(120_000) // 一次空闲轮询
  expect(f.completes).toBe(1)
  expect(f.toasts.some(t => t.includes('拦截已解除'))).toBe(true)
  expect(f.statuses.at(-1)).toBe('🟢 用量 5h 3% · 7d 5%')
})

test('换到的账号同样超过阈值时继续拦截，并显示新账号的用量', async ($, on) => {
  const { f, clock } = world(on, 11, 95)
  f.other = { five: 97, seven: 40 }
  await start($, clock)
  f.disk = 'acct-b'
  await clock.advance(3_000)
  const drop = dropOf(await submit($))
  expect(drop).toContain('5 小时限额 已用 97%')
  expect(drop).not.toContain('7 天总限额 已用 95%')
  expect(f.completes).toBe(1)
})

test('本会话自己 /login 换号时不额外发请求', async ($, on) => {
  const { f, clock } = world(on, 11, 95)
  await start($, clock)
  expect(dropOf(await submit($))).toBeDefined()

  f.disk = 'acct-b' // 本会话 /login：引擎的 token 同时换掉
  f.token = 'acct-b'
  await clock.advance(3_000)
  expect(dropOf(await submit($))).toBeUndefined()
  expect(f.completes).toBe(0)
})

test('没能换过去时只试一次，并提示在本会话 /login；/usage-guard 可以再试', async ($, on) => {
  const { f, clock } = world(on, 11, 95)
  f.rereads = false // 比如用环境变量里的 token 启动的会话
  await start($, clock)
  f.disk = 'acct-b'

  await clock.advance(3_000)
  const drop = dropOf(await submit($))
  expect(drop).toContain('检测到其他会话已登录 acct-b@example.com')
  expect(drop).not.toContain('\n')
  expect(f.completes).toBe(1)

  await clock.advance(3_000)
  expect(dropOf(await submit($))).toContain('拦截阈值')
  expect(f.completes).toBe(1)

  await clock.advance(3_000)
  const out = await command($, '')
  expect(f.completes).toBe(2)
  expect(out.text).toContain('检测到其他会话已登录 acct-b@example.com')
})

test('读不到全局配置时不核对账号，照旧工作', async ($, on) => {
  const { f, clock } = world(on, 11, 95)
  f.disk = undefined
  await start($, clock)
  expect(dropOf(await submit($))).toContain('拦截阈值')
  expect(f.profiles).toBe(0)
  expect(f.completes).toBe(0)
})
