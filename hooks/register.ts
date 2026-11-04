// usage-guard：实时监控当前账号的订阅用量，达到阈值时拦截并停止所有任务。
//
// 数据来源（都用当前会话自己的凭证，凭证本身不会经过插件）：
//   1. 引擎从每次模型响应头读到的限额：`session.measure` 推送 + 每次模型请求后读取，零额外请求；
//   2. 用量接口 GET /api/oauth/usage：会话启动时、空闲轮询时、提示词提交前数据过旧时查询。
//
// 拦截点（达到阈值且未暂停时）：
//   prompt.submit  丢弃新的提示词（用户输入、/loop、后台通知等）
//   turn.step      不再发送任何模型请求（主线程、子代理、队友都算），直接以拦截说明结束
//   tool.call      拒绝所有工具调用
//   agent.spawn    拒绝启动子代理
//   跨过阈值的那一刻：中止正在运行的主回合，并弹出提示和系统通知。
//
// 平时不弹任何提示：低于阈值时只在状态栏显示用量（≥ warnAt 变黄）。
//
// 失败策略：拿不到用量时放行（fail-open），插件出错也不会把会话锁死。

import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import {
  blockLine,
  blockMessage,
  clockText,
  denyMessage,
  fromLive,
  merge,
  over,
  parseUsageResponse,
  report,
  statusText,
  type LiveLimit,
  type Settings,
  type Window,
} from './usage'

type Engine = EngineInterface

const COMMAND = 'usage-guard'
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
/** `$.store` 键：暂停拦截到何时（毫秒时间戳），所有会话共用。 */
const PAUSE_KEY = 'pausedUntil'

const FETCH_TIMEOUT_MS = 4_000
/** 提交提示词时，数据旧于这个时长就重新查询。 */
const PROMPT_FRESH_MS = 30_000
/** 发送模型请求前，数据旧于这个时长就重新查询（回合进行中每次响应都会刷新数据）。 */
const STEP_FRESH_MS = 90_000
/** 自动查询之间的最小间隔。 */
const AUTO_GAP_MS = 10_000
/** 用户主动触发（被拦截时提交提示词、/usage-guard）的最小间隔。 */
const FORCED_GAP_MS = 3_000
const MAX_BACKOFF_MS = 5 * 60_000
/**
 * 解除拦截的余量（百分点）：拦截后要降到「阈值 − 余量」以下才放行。
 * 用量接口和响应头给的百分比常差 1 左右（如 93 / 92.4），没有余量会在两者之间来回拦截、放行、弹窗。
 */
const RELEASE_MARGIN = 1

/** 本次加载的全部状态（热重载时重新开始，暂停状态在 `$.store` 里）。 */
type Guard = {
  settings: Settings
  pollMs: number
  windows: Window[]
  readAt: number
  pausedUntil: number
  isBlocking: boolean
  mainTurnId: string | undefined
  inflight: Promise<void> | undefined
  lastFetchAt: number
  failures: number
  lastError: string | undefined
}

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : fallback
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 120)

function makeGuard(options: PluginOptions): Guard {
  const threshold = Math.min(100, Math.max(1, num(options.threshold, 93)))
  const warnAt = Math.min(threshold, Math.max(0, num(options.warnAt, 85)))
  return {
    settings: { threshold, warnAt },
    pollMs: Math.max(30, num(options.pollSeconds, 120)) * 1000,
    windows: [],
    readAt: 0,
    pausedUntil: 0,
    isBlocking: false,
    mainTurnId: undefined,
    inflight: undefined,
    lastFetchAt: 0,
    failures: 0,
    lastError: undefined,
  }
}

/** 拦截所依据的窗口：已在拦截中时按「阈值 − 余量」判断，避免在阈值附近来回切换。 */
const hitOf = (g: Guard, now: number): Window[] =>
  over(g.windows, g.isBlocking ? g.settings.threshold - RELEASE_MARGIN : g.settings.threshold, now)

const isBlockedAt = (g: Guard, now: number): boolean => g.pausedUntil <= now && hitOf(g, now).length > 0

type Settled<T> = { value: T } | { error: string }

/** 带超时地等一个 `$` 调用（`$.http.fetch` 本身没有超时）。 */
function settle<T>($: Engine, p: Promise<T>, ms: number): Promise<Settled<T>> {
  return new Promise(resolve => {
    const timer = $.clock.after(ms, () => resolve({ error: '查询超时' }))
    p.then(
      value => {
        timer.cancel()
        resolve({ value })
      },
      (err: unknown) => {
        timer.cancel()
        resolve({ error: errorText(err) })
      },
    )
  })
}

// ---------------------------------------------------------------- 读取用量

async function fetchUsage($: Engine, g: Guard): Promise<void> {
  const auth = await $.session.authorize()
  g.lastFetchAt = await $.clock.now()
  if (auth === null || auth.kind !== 'bearer') {
    // API Key / 第三方平台：没有订阅限额可查，久一点再试（之后可能 /login 了）。
    g.lastError = '当前会话不是 Claude 订阅登录（API Key 等不受订阅限额约束）'
    g.failures = 99
    return
  }
  const res = await settle(
    $,
    $.http.fetch(USAGE_URL, {
      auth: auth.handle,
      headers: { 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
    }),
    FETCH_TIMEOUT_MS,
  )
  const now = await $.clock.now()
  const fail = (why: string): void => {
    g.failures += 1
    g.lastError = why
  }
  if ('error' in res) return fail(res.error)
  if (!res.value.ok) return fail(`HTTP ${res.value.status}`)
  let body: unknown
  try {
    body = JSON.parse(res.value.text)
  } catch {
    return fail('返回内容无法解析')
  }
  g.windows = merge(g.windows, parseUsageResponse(body, now), true)
  g.readAt = now
  g.failures = 0
  g.lastError = undefined
}

/** 数据旧于 maxAgeMs 时查询用量接口（并发合并、失败退避）。 */
async function refresh($: Engine, g: Guard, maxAgeMs: number, minGapMs = AUTO_GAP_MS): Promise<void> {
  const now = await $.clock.now()
  if (now - g.readAt < maxAgeMs) return
  const backoff = g.failures > 0 ? Math.min(MAX_BACKOFF_MS, AUTO_GAP_MS * 2 ** (g.failures - 1)) : 0
  if (g.inflight === undefined && now - g.lastFetchAt < Math.max(minGapMs, backoff)) return
  g.inflight ??= fetchUsage($, g)
    .catch((err: unknown) => {
      g.failures += 1
      g.lastError = errorText(err)
    })
    .finally(() => {
      g.inflight = undefined
    })
  await g.inflight
}

/** 吸收引擎从响应头读到的限额。 */
async function absorbLive($: Engine, g: Guard, limits: readonly LiveLimit[]): Promise<void> {
  if (limits.length === 0) return
  const now = await $.clock.now()
  g.windows = merge(g.windows, fromLive(limits, now), false)
  g.readAt = now
}

// ---------------------------------------------------------------- 判断与提示

/** 重新判断是否拦截，处理状态切换、预警和状态栏；返回此刻是否拦截。 */
async function evaluate($: Engine, g: Guard): Promise<boolean> {
  const now = await $.clock.now()
  try {
    g.pausedUntil = num(await $.store.get(PAUSE_KEY), 0)
  } catch {
    // 读不到就沿用内存里的值
  }
  const hit = hitOf(g, now)
  const block = g.pausedUntil <= now && hit.length > 0

  if (block && !g.isBlocking) {
    g.isBlocking = true
    onBlock($, g, hit, now)
  } else if (!block && g.isBlocking) {
    g.isBlocking = false
    if (g.pausedUntil <= now) {
      $.ui.toast('✅ usage-guard：用量已低于阈值（额度已恢复或已切换账号），拦截已解除。', { timeoutMs: 8_000 })
    }
  }

  $.ui.status(statusText(g.windows, g.settings, now, g.pausedUntil, block))
  return block
}

/** 刚跨过阈值：提示、系统通知，并中止正在运行的主回合。都不等待，避免卡住当前钩子。 */
function onBlock($: Engine, g: Guard, hit: Window[], now: number): void {
  const text = blockMessage(hit, g.settings, now)
  $.ui.toast(blockLine(hit, g.settings, now), { timeoutMs: 30_000 })
  $.ui
    .notify(`当前账号用量已达 ${g.settings.threshold}%，所有任务已停止。请切换账号（/login）或等待额度恢复。`, {
      title: 'Claude Code · usage-guard',
    })
    .catch(() => undefined)
  const turnId = g.mainTurnId
  if (turnId !== undefined) {
    $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } }).catch(() => undefined)
    $.turn.abort({ turnId }).catch(() => undefined)
  }
}

/** 拦截说明：`isOneLine` 用于只显示一行的地方（丢弃提示词的理由）。 */
async function stopText($: Engine, g: Guard, isOneLine: boolean): Promise<string> {
  const now = await $.clock.now()
  return (isOneLine ? blockLine : blockMessage)(hitOf(g, now), g.settings, now)
}

async function tick($: Engine, g: Guard, isFirst: boolean): Promise<void> {
  try {
    // 回合进行中时响应头会持续刷新数据，只在空闲时查询接口。
    if (isFirst) await refresh($, g, 0, 0)
    else if (g.mainTurnId === undefined) await refresh($, g, g.pollMs - 5_000)
    await evaluate($, g)
  } catch {
    // 定时器里的错误不影响会话
  }
}

async function runCommand($: Engine, g: Guard, args: string): Promise<string> {
  const [verb = 'status', arg] = args.trim().split(/\s+/).filter(Boolean)
  const now = await $.clock.now()

  if (verb === 'pause' || verb === 'off') {
    const minutes = Math.round(Math.min(24 * 60, Math.max(1, num(arg, 30))))
    const until = now + minutes * 60_000
    await $.store.set(PAUSE_KEY, until)
    await evaluate($, g)
    return (
      `⏸ usage-guard 已暂停拦截 ${minutes} 分钟（至 ${clockText(until)}，对所有会话生效）。` +
      '期间达到阈值也不会拦截，风险自负；/usage-guard resume 可提前恢复。'
    )
  }

  const isResume = verb === 'resume' || verb === 'on'
  if (!isResume && verb !== 'status' && verb !== 'refresh') {
    return '用法：/usage-guard [status]｜/usage-guard pause <分钟>｜/usage-guard resume'
  }
  if (isResume) await $.store.delete(PAUSE_KEY)
  await refresh($, g, 0, FORCED_GAP_MS)
  await evaluate($, g)
  const at = await $.clock.now()
  const text = report(g.windows, g.settings, at, {
    pausedUntil: g.pausedUntil,
    readAt: g.readAt,
    error: g.lastError,
    hit: g.isBlocking ? hitOf(g, at) : [],
  })
  return isResume ? `▶️ usage-guard 已恢复拦截。\n${text}` : text
}

// ---------------------------------------------------------------- 钩子

export const register: Register = (on, options) => {
  const g = makeGuard(options)

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: COMMAND,
        description: '查看当前账号用量与拦截状态；pause [分钟] 临时暂停拦截，resume 恢复',
        argumentHint: '[status | pause <分钟> | resume]',
        immediate: true,
      })
    } catch {
      // 无界面的宿主可能不支持命令
    }
    $.clock.after(1, () => void tick($, g, true))
    $.clock.every(g.pollMs, () => void tick($, g, false))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    try {
      if (e.changed.includes('rateLimits')) {
        await absorbLive($, g, e.rateLimits)
        await evaluate($, g)
      }
    } catch {
      // 只是观察
    }
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) g.mainTurnId = e.turnId
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.turnId === g.mainTurnId) g.mainTurnId = undefined
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command?.name === COMMAND) return next(e)
    try {
      // 已在拦截中时每次都重新查询：切换账号或额度恢复后可以马上放行。
      await refresh($, g, g.isBlocking ? 0 : PROMPT_FRESH_MS, g.isBlocking ? FORCED_GAP_MS : AUTO_GAP_MS)
      if (await evaluate($, g)) return { drop: await stopText($, g, true) }
    } catch {
      // fail-open
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    let stop: string | undefined
    try {
      await refresh($, g, STEP_FRESH_MS)
      if (await evaluate($, g)) stop = await stopText($, g, false)
    } catch {
      stop = undefined
    }

    if (stop === undefined) {
      const response = yield* next(e)
      try {
        // 这次响应的响应头已更新引擎里的限额：吸收它，若刚跨过阈值则立即停止。
        await absorbLive($, g, (await $.session.usage()).rateLimits)
        await evaluate($, g)
      } catch {
        // 只是观察
      }
      return response
    }

    // 不发送这次模型请求，直接以拦截说明作为回答结束回合。
    yield { kind: 'text', index: 0, text: stop }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: stop, toolUses: [], stopReason: 'end_turn', usage: null }
  })

  on('tool.call', async ($, e, next) => {
    const now = await $.clock.now()
    if (isBlockedAt(g, now)) return { deny: denyMessage(hitOf(g, now), g.settings) }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const now = await $.clock.now()
    if (isBlockedAt(g, now)) return { deny: denyMessage(hitOf(g, now), g.settings) }
    return next(e)
  })

  on('command.run', { command: 'usage-guard' }, async ($, e) => ({ text: await runCommand($, g, e.args) }))
}
