// usage-guard 的纯逻辑：解析用量、判断是否拦截、生成提示文字。
// 不碰 `$`，由 register.ts 和测试共用。

/** 账号的一个限额窗口，最近一次读到的数值。 */
export type Window = {
  /** five_hour、seven_day、seven_day_opus……（引擎与用量接口顶层字段的名字） */
  kind: string
  /** 已用百分比 0~100（超额的消费限额可超过 100） */
  percent: number
  /** 重置时间，ISO 8601 */
  resetsAt?: string
  /** 读到这个数值的时间，毫秒时间戳 */
  at: number
}

export type Settings = { threshold: number; warnAt: number }

/** 引擎 `$.session.usage().rateLimits` 里的一项。 */
export type LiveLimit = { kind: string; percentUsed: number; resetsAt?: string }

const NAMES: Record<string, string> = {
  five_hour: '5 小时限额',
  seven_day: '7 天总限额',
  seven_day_opus: '7 天 Opus 限额',
  seven_day_sonnet: '7 天 Sonnet 限额',
  seven_day_oauth_apps: '7 天 OAuth 应用限额',
  seven_day_cowork: '7 天 Cowork 限额',
  spend_limit: '消费限额',
}

const SHORT: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_opus: '7d·Opus',
  seven_day_sonnet: '7d·Sonnet',
  seven_day_oauth_apps: '7d·OAuth',
  seven_day_cowork: '7d·Cowork',
  spend_limit: '$',
}

/** 用量接口 `limits` 列表里的名字 → 顶层字段的名字。 */
const LIMIT_KINDS: Record<string, string> = {
  session: 'five_hour',
  weekly_all: 'seven_day',
  weekly_opus: 'seven_day_opus',
  weekly_sonnet: 'seven_day_sonnet',
}

const ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']

export const nameOf = (kind: string): string => NAMES[kind] ?? kind
export const shortOf = (kind: string): string => SHORT[kind] ?? kind

const round1 = (n: number): number => Math.round(n * 10) / 10
export const pct = (n: number): string => `${round1(n)}%`

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const rank = (kind: string): number => {
  const i = ORDER.indexOf(kind)
  return i === -1 ? ORDER.length : i
}

const byOrder = (a: Window, b: Window): number => rank(a.kind) - rank(b.kind)

/**
 * 解析 GET https://api.anthropic.com/api/oauth/usage 的返回。
 * 顶层 `five_hour`/`seven_day`/… 为 `{ utilization, resets_at }`；
 * `limits` 列表是另一种写法，只补充顶层没有的窗口。
 */
export function parseUsageResponse(raw: unknown, at: number): Window[] {
  if (!isRecord(raw)) return []
  const found = new Map<string, Window>()

  for (const [kind, v] of Object.entries(raw)) {
    if (!isRecord(v) || typeof v.utilization !== 'number' || !('resets_at' in v)) continue
    found.set(kind, {
      kind,
      percent: round1(v.utilization),
      resetsAt: typeof v.resets_at === 'string' ? v.resets_at : undefined,
      at,
    })
  }

  if (Array.isArray(raw.limits)) {
    for (const item of raw.limits) {
      if (!isRecord(item) || typeof item.kind !== 'string' || typeof item.percent !== 'number') continue
      const kind = LIMIT_KINDS[item.kind] ?? item.kind
      if (found.has(kind)) continue
      found.set(kind, {
        kind,
        percent: round1(item.percent),
        resetsAt: typeof item.resets_at === 'string' ? item.resets_at : undefined,
        at,
      })
    }
  }

  return [...found.values()].sort(byOrder)
}

/** 引擎从每次模型响应头里读到的限额 → Window。 */
export function fromLive(limits: readonly LiveLimit[], at: number): Window[] {
  return limits
    .filter(l => typeof l.percentUsed === 'number' && Number.isFinite(l.percentUsed))
    .map(l => ({ kind: l.kind, percent: round1(l.percentUsed), resetsAt: l.resetsAt, at }))
}

/** 用量接口的结果是整份（替换已知的）；响应头只更新它带到的窗口。 */
export function merge(known: readonly Window[], incoming: readonly Window[], isWhole: boolean): Window[] {
  if (isWhole) return [...incoming].sort(byOrder)
  const byKind = new Map(known.map(w => [w.kind, w] as const))
  for (const w of incoming) byKind.set(w.kind, w)
  return [...byKind.values()].sort(byOrder)
}

export function resetAt(w: Window): number | undefined {
  if (w.resetsAt === undefined) return undefined
  const t = Date.parse(w.resetsAt)
  return Number.isFinite(t) ? t : undefined
}

/** 还在计数的窗口：重置时间已过的窗口已经清零，不再算。 */
export function live(ws: readonly Window[], now: number): Window[] {
  return ws.filter(w => {
    const r = resetAt(w)
    return r === undefined || r > now
  })
}

/** 达到阈值的窗口，用量高的在前。 */
export function over(ws: readonly Window[], threshold: number, now: number): Window[] {
  return live(ws, now)
    .filter(w => w.percent >= threshold)
    .sort((a, b) => b.percent - a.percent)
}

// ---------------------------------------------------------------- 文字

const pad = (n: number): string => String(n).padStart(2, '0')

/** 本地时间 `MM-DD HH:mm`。 */
export function clockText(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `2天3小时` / `45分钟`。 */
export function durationText(ms: number): string {
  const mins = Math.max(0, Math.ceil(ms / 60_000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}天${h > 0 ? `${h}小时` : ''}`
  if (h > 0) return `${h}小时${m > 0 ? `${m}分钟` : ''}`
  return `${m}分钟`
}

export function resetText(w: Window, now: number): string {
  const r = resetAt(w)
  // 接口给的重置时间常是 03:59:59.9 这样，按分钟四舍五入后显示 04:00。
  return r === undefined ? '重置时间未知' : `${clockText(Math.round(r / 60_000) * 60_000)} 重置（约 ${durationText(r - now)}后）`
}

const hitList = (hit: readonly Window[]): string =>
  hit.map(w => `${nameOf(w.kind)} ${pct(w.percent)}`).join('，')

/** 给用户看的拦截说明。 */
export function blockMessage(hit: readonly Window[], s: Settings, now: number): string {
  return [
    `⛔ usage-guard：当前账号用量已达到 ${s.threshold}% 拦截阈值，已自动停止所有任务。`,
    ...hit.map(w => `   • ${nameOf(w.kind)} 已用 ${pct(w.percent)}，${resetText(w, now)}`),
    '接下来可以：',
    '   1) 切换账号：运行 /login 登录另一个账号，然后重新发送消息（新账号用量低于阈值即自动放行）',
    '   2) 等待额度恢复：到上面的重置时间后自动放行',
    '   3) 临时放行（风险自负）：/usage-guard pause 30 暂停拦截 30 分钟，/usage-guard resume 恢复',
  ].join('\n')
}

/** 单行版本：丢弃提示词的理由、弹出提示只显示一行（换行会被替换掉）。 */
export function blockLine(hit: readonly Window[], s: Settings, now: number): string {
  const what = hit.map(w => `${nameOf(w.kind)} 已用 ${pct(w.percent)}，${resetText(w, now)}`).join('；')
  return (
    `⛔ usage-guard：当前账号用量已达到 ${s.threshold}% 拦截阈值，已自动停止所有任务。${what}。` +
    '可以：① 运行 /login 切换账号后重新发送；② 等到重置时间自动放行；③ /usage-guard pause 30 临时放行（风险自负）。'
  )
}

/** 拒绝工具调用 / 子代理时给模型看的理由。 */
export function denyMessage(hit: readonly Window[], s: Settings): string {
  return (
    `usage-guard：账号用量已达到 ${s.threshold}% 拦截阈值（${hitList(hit)}），所有任务已被停止。` +
    '不要重试，也不要再调用任何工具；直接结束本回合，并告诉用户切换账号（/login）或等待额度恢复。'
  )
}

/** 状态栏一行；没有任何数据时为 undefined（不占位）。 */
export function statusText(
  ws: readonly Window[],
  s: Settings,
  now: number,
  pausedUntil: number,
  isBlocking = false,
): string | undefined {
  const shown = live(ws, now)
  if (shown.length === 0) return undefined
  const top = Math.max(...shown.map(w => w.percent))
  const isPaused = pausedUntil > now
  const isHit = isBlocking || top >= s.threshold
  const lead = isHit ? (isPaused ? '⏸' : '⛔') : top >= s.warnAt ? '🟡' : '🟢'
  const parts = shown.map(w => `${shortOf(w.kind)} ${pct(w.percent)}`).join(' · ')
  const tail = isPaused
    ? ` · 拦截暂停至 ${clockText(pausedUntil)}`
    : isHit
      ? ` · 已拦截（阈值 ${s.threshold}%）`
      : ''
  return `${lead} 用量 ${parts}${tail}`
}

/** `hit`：正在拦截时给出拦截所依据的窗口（含解除余量内的），省略时按阈值计算。 */
export type ReportInfo = { pausedUntil: number; readAt: number; error?: string; hit?: readonly Window[] }

/** `/usage-guard` 的输出。 */
export function report(ws: readonly Window[], s: Settings, now: number, info: ReportInfo): string {
  const shown = live(ws, now)
  const hit = info.hit ?? over(ws, s.threshold, now)
  const isPaused = info.pausedUntil > now
  const state = isPaused
    ? `⏸ 已暂停至 ${clockText(info.pausedUntil)}`
    : hit.length > 0
      ? '⛔ 正在拦截'
      : '✅ 未触发'
  const lines = [
    `拦截阈值 ${s.threshold}% · 预警 ${s.warnAt}% · 状态：${state}`,
    ...(shown.length > 0
      ? shown.map(w => `   • ${nameOf(w.kind)}：${pct(w.percent)}，${resetText(w, now)}`)
      : ['   暂无用量数据（当前会话不是 Claude 订阅登录，或用量接口暂时不可用）']),
  ]
  if (info.readAt > 0) lines.push(`   数据时间：${clockText(info.readAt)}`)
  if (info.error !== undefined) lines.push(`   最近一次查询用量接口失败：${info.error}`)
  if (hit.length > 0 && !isPaused) lines.push('', blockMessage(hit, s, now))
  return lines.join('\n')
}
