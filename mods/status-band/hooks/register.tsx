import type { EngineInterface, Register, SessionRateLimit, SessionUsage, TurnUsage } from 'claude-code'

// ---- 配色（ダーク・ライトどちらの背景でも読みやすい落ち着いた色） ----
const ACCENT = '#8AB4F8' // モデル名・作業中表示
const EFFORT = '#F2B880' // 推論の強さ
const PLACE = '#9CC8C0' // フォルダ
const BRANCH = '#C3A6E8' // Gitブランチ
const OK = '#7FD1AE' // 〜49%
const WARN = '#E5C07B' // 50〜79%
const DANGER = '#EF7B7B' // 80%〜
const ON_BADGE = '#1B1D22' // ラベルの文字色（色付き背景の上）

// 左端のラベルの幅（「コンテキスト」＝全角6文字）。各行のバーの開始位置をそろえる
const LABEL_COLS = 12

// 使用制限の枠の長さ
const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 60 * 60 * 1000,
  seven_day: 7 * 24 * 60 * 60 * 1000,
}

// ---- 小さな部品 ----

// 使用率に応じた色
export function levelColor(pct: number): string {
  if (pct >= 80) return DANGER
  if (pct >= 50) return WARN
  return OK
}

// 進捗バーの「使用済み」「予測で増える分」「残り」の文字数
export function barCells(
  pct: number,
  width: number,
  projected?: number,
): { filled: number; ahead: number; empty: number } {
  const cells = (p: number) => Math.round((Math.max(0, Math.min(100, p)) / 100) * width)
  const filled = cells(pct)
  const ahead = projected === undefined ? 0 : Math.max(0, cells(projected) - filled)
  return { filled, ahead, empty: width - filled - ahead }
}

// 表示幅（全角は2）
function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += /[　-鿿＀-￯]/.test(ch) ? 2 : 1
  return w
}

// ラベルを決まった幅にそろえる
export function padLabel(s: string, cols: number = LABEL_COLS): string {
  return s + ' '.repeat(Math.max(0, cols - displayWidth(s)))
}

// 1234 → 1k、1234567 → 1.2M
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

// "claude-opus-5-5[1m]" → "Opus 5.5"
export function prettyModel(raw: string): string {
  const id = raw.replace(/\[.*\]$/, '').trim()
  const m = /^(?:claude-)?(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(id)
  if (m) {
    const name = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase()
    return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`
  }
  return id.replace(/^Claude\s+/i, '')
}

// "/Users/foo/Project/x" → "~/Project/x"（長いときは末尾を残して省略）
export function prettyPath(path: string, max: number): string {
  const short = path.replace(/^\/Users\/[^/]+/, '~')
  if (short.length <= max) return short
  const parts = short.split('/')
  const tail = parts.slice(-2).join('/')
  return `…/${tail}`.length <= max ? `…/${tail}` : `…/${parts.at(-1) ?? ''}`
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

// 時刻の表示：5時間枠は「15:00」、週間枠は「10/9(木) 10時」
export function formatTime(d: Date, kind: string): string {
  if (kind === 'seven_day') return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]}) ${d.getHours()}時`
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 残り時間：「あと13分」「あと2時間13分」「あと3日22時間」
export function formatRemaining(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000))
  if (min < 60) return `あと${min}分`
  const h = Math.floor(min / 60)
  if (h < 24) return `あと${h}時間${min % 60 ? `${min % 60}分` : ''}`
  return `あと${Math.floor(h / 24)}日${h % 24 ? `${h % 24}時間` : ''}`
}

// 84秒 → "1:24"、3725秒 → "1:02:05"
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

// 上限の見通し：この枠が始まってからの平均ペースが続いた場合の、リセット時点の使用率と、
// 100%に届く時刻（リセット前に届く場合のみ）。
// 判断材料が少なすぎる（使用1%未満・枠の開始から10分未満）ときは undefined。
export type Outlook = { atReset: number; fullAt: number | null; resetAt: number }

export function outlook(limit: SessionRateLimit, now: number): Outlook | undefined {
  const len = WINDOW_MS[limit.kind]
  if (!len || !limit.resetsAt) return undefined
  const resetAt = new Date(limit.resetsAt).getTime()
  if (Number.isNaN(resetAt)) return undefined
  if (limit.percentUsed >= 100) return { atReset: limit.percentUsed, fullAt: now, resetAt }
  const start = resetAt - len
  const elapsed = now - start
  if (limit.percentUsed < 1 || elapsed < 10 * 60 * 1000) return undefined
  const atReset = (limit.percentUsed * len) / elapsed
  const fullAt = start + (elapsed * 100) / limit.percentUsed
  return { atReset, fullAt: fullAt < resetAt ? fullAt : null, resetAt }
}

// 見通しの判定：余力あり（リセット時80%未満）／上限接近（80〜99%）／上限見込み／上限到達
export type Verdict = 'ok' | 'tight' | 'over' | 'hit'

export function verdictOf(limit: SessionRateLimit, o: Outlook): Verdict {
  if (limit.percentUsed >= 100) return 'hit'
  if (o.fullAt !== null) return 'over'
  return o.atReset >= 80 ? 'tight' : 'ok'
}

function findLimit(limits: readonly SessionRateLimit[], kind: string): SessionRateLimit | undefined {
  return limits.find(l => l.kind === kind)
}

// ---- キャッシュ ----
// 直前の問い合わせ：いつ送ったか、キャッシュから読んだ量・書いた量・新しく読んだ量
export type CacheRequest = { at: number; read: number; write: number; fresh: number }
export type CacheState = 'warm' | 'expiring' | 'expired' | 'missed'

// キャッシュの有効期間：サブスクリプション（使用制限の枠がある）なら1時間、それ以外は5分
export function cacheTtlMs(limits: readonly SessionRateLimit[]): number {
  const isSubscription = limits.some(l => l.kind === 'five_hour' || l.kind === 'seven_day')
  return (isSubscription ? 60 : 5) * 60 * 1000
}

// ヒット率（%）：キャッシュから読めた量 ÷ 入力全体
export function cacheHitPct(r: CacheRequest): number {
  const total = r.read + r.write + r.fresh
  return total === 0 ? 0 : (r.read / total) * 100
}

// 期限切れ間近とみなす残り時間：1時間なら残り5分、5分なら残り1分
export function cacheLeadMs(ttl: number): number {
  return ttl >= 60 * 60 * 1000 ? 5 * 60 * 1000 : 60 * 1000
}

// 一定以上の大きさの会話で、キャッシュをほとんど再利用できなかったら「外れ」
const CACHE_MISS_MIN_TOKENS = 20_000

export function cacheStateOf(r: CacheRequest, ttl: number, now: number): CacheState {
  const left = r.at + ttl - now
  if (left <= 0) return 'expired'
  if (r.read + r.write + r.fresh >= CACHE_MISS_MIN_TOKENS && cacheHitPct(r) < 50) return 'missed'
  return left <= cacheLeadMs(ttl) ? 'expiring' : 'warm'
}

// 入力トークン：キャッシュから読んだ分・書いた分も含めた合計
function inputTokens(u: TurnUsage): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

// ---- 描画のたびに呼ぶと重いもの・イベントで知るものは、ここに覚えておく ----
let model = ''
let place = ''
let branch = ''
let effort = ''
// 今のターン（作業中のみ）と、直前に終わったターン
type TurnStats = { ms: number; tools: number; input: number; output: number }
let turnId = ''
let turnStartedAt = 0
let current: TurnStats = { ms: 0, tools: 0, input: 0, output: 0 }
let lastTurn: TurnStats | null = null
// 直前の問い合わせのキャッシュ状況と、期限切れ前のお知らせを出した問い合わせ
let lastRequest: CacheRequest | null = null
let warnedAt = 0

// モデル名・フォルダ・ブランチを取り直す
async function refreshIdentity($: EngineInterface): Promise<void> {
  model = prettyModel(await $.session.model())
  const cwd = await $.session.cwd()
  place = cwd
  try {
    const r = await $.process.run(['git', 'symbolic-ref', '--short', 'HEAD'], { cwd, timeoutMs: 3000 })
    branch = r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {
    branch = ''
  }
  $.ui.invalidate('ui.render')
}

// 前のセッションで最後に見た effort を、最初の問い合わせまでの仮表示に使う
// キャッシュがもうすぐ切れるとき、1回だけお知らせする（会話が大きいときのみ）
async function checkCacheExpiry($: EngineInterface): Promise<void> {
  const r = lastRequest
  if (!r || turnId || warnedAt === r.at) return
  if (r.read + r.write + r.fresh < CACHE_MISS_MIN_TOKENS) return
  const ttl = cacheTtlMs((await $.session.usage()).rateLimits)
  const left = r.at + ttl - (await $.clock.now())
  if (left > 0 && left <= cacheLeadMs(ttl)) {
    warnedAt = r.at
    const mins = Math.max(1, Math.round(left / 60_000))
    $.ui.toast(
      `キャッシュがあと約${mins}分で切れます。続けるなら早めに送信を（切れると ${formatTokens(r.read + r.write + r.fresh)} を読み直します）`,
      { timeoutMs: 10_000 },
    )
  }
}

async function loadEffort($: EngineInterface): Promise<void> {
  const saved = await $.store.get('effort')
  if (typeof saved === 'string' && !effort) effort = saved
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadEffort($)
    await refreshIdentity($)
    // ブランチの切り替えなど、外での変化も拾えるよう30秒ごとに取り直す
    $.clock.every(30_000, () => void refreshIdentity($))
    // 作業中は経過時間を1秒ごとに進める
    $.clock.every(1_000, () => {
      if (turnId) $.ui.invalidate('ui.render')
    })
    // キャッシュの期限切れが近づいていないか確認する
    $.clock.every(15_000, () => void checkCacheExpiry($))
    return next(e)
  })

  // 使用量が動いたら描き直す
  on('session.measure', ($, e, next) => {
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // ターン開始：経過時間・ツール回数・トークンを数え始める
  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    turnId = result.turnId
    turnStartedAt = await $.clock.now()
    current = { ms: 0, tools: 0, input: 0, output: 0 }
    $.ui.invalidate('ui.render')
    return result
  })

  // ツールを使うたびに数える
  on('tool.call', ($, e, next) => {
    if (turnId) {
      current.tools += 1
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // AI への問い合わせのたびに、effort を読み、トークンを足していく（サブエージェント分は除く）
  on('turn.step', async function* ($, e, next) {
    const isMain = !e.agentId
    if (isMain) {
      const level = e.effort === undefined ? '' : String(e.effort)
      if (level !== effort) {
        effort = level
        $.ui.invalidate('ui.render')
        if (level) await $.store.set('effort', level)
      }
    }
    const sentAt = isMain ? await $.clock.now() : 0
    const result = yield* next(e)
    if (isMain && result.usage) {
      const u = result.usage
      lastRequest = {
        at: sentAt,
        read: u.cache_read_input_tokens,
        write: u.cache_creation_input_tokens,
        fresh: u.input_tokens,
      }
    }
    if (isMain && turnId && result.usage) {
      current.input += inputTokens(result.usage)
      current.output += result.usage.output_tokens
      $.ui.invalidate('ui.render')
    }
    return result
  })

  // ターン終了：結果を「直近」として残し、モデル名やブランチを取り直す
  on('turn.complete', async ($, e, next) => {
    if (turnId && e.turnId === turnId) {
      const ms = (await $.clock.now()) - turnStartedAt
      // エンジンが集計した合計があればそちらを使う
      const total = e.usage
      lastTurn = total
        ? { ms, tools: current.tools, input: inputTokens(total), output: total.output_tokens }
        : { ...current, ms }
      turnId = ''
    }
    await refreshIdentity($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // アンケート表示中は譲る
    if (e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const usage: SessionUsage = await $.session.usage()
    const now = await $.clock.now()
    // CLI では帯全体を枠で囲み、会話との境目をはっきりさせる（枠と内側の余白で4列使う）
    const framed = e.surface === 'terminal'
    const cols = Math.max(40, e.props.bodyColumns - (framed ? 4 : 0))

    // 横幅に合わせてバーの長さを決める（全行同じ長さにして縦にそろえる）
    const barWidth = Math.max(8, Math.min(24, cols - 64))

    const bar = (key: string, pct: number, projected?: number) => {
      const { filled, ahead, empty } = barCells(pct, barWidth, projected)
      return (
        <Box key={key} flexDirection="row">
          <Text color={levelColor(pct)}>{'━'.repeat(filled)}</Text>
          {ahead > 0 ? <Text color={levelColor(projected ?? pct)}>{'╍'.repeat(ahead)}</Text> : null}
          <Text dimColor>{'━'.repeat(empty)}</Text>
        </Box>
      )
    }

    const pctText = (pct: number) => (
      <Text color={levelColor(pct)} bold>
        {`${Math.round(pct)}%`.padStart(4)}
      </Text>
    )

    const label = (text: string) => <Text dimColor>{padLabel(text)}</Text>

    // ---- 1行目：モデル・effort ・ フォルダ ・ ブランチ　　　　　　コスト ----
    const cost = usage.cost?.usd
    const line1 = (
      <Box key="l1" flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" columnGap={1} flexShrink={1}>
          <Text color={ACCENT} bold>
            {`◆ ${model || '—'}`}
          </Text>
          {effort ? <Text color={EFFORT}>{effort}</Text> : null}
          <Text dimColor>│</Text>
          <Text color={PLACE} wrap="truncate-start">
            {prettyPath(place, Math.max(12, cols - 50))}
          </Text>
          {branch ? <Text color={BRANCH}>{`⎇ ${branch}`}</Text> : null}
        </Box>
        {cost !== undefined ? <Text dimColor>{`≈ $${cost.toFixed(2)}`}</Text> : null}
      </Box>
    )

    // ---- 2行目：作業中／直近のターン（まだ作業がなければ出さない） ----
    const working = turnId !== ''
    const stats = working ? { ...current, ms: now - turnStartedAt } : lastTurn
    const line2 = stats ? (
      <Box key="l2" flexDirection="row" columnGap={1}>
        <Text color={working ? ACCENT : undefined} dimColor={!working} bold={working}>
          {padLabel(working ? '● 作業中' : '直近')}
        </Text>
        <Text color={working ? ACCENT : undefined} dimColor={!working}>
          {`⏱ ${formatElapsed(stats.ms)}   ツール ${stats.tools}回   入力 ${formatTokens(stats.input)}   出力 ${formatTokens(stats.output)}`}
        </Text>
      </Box>
    ) : null

    // ---- 3行目：コンテキスト　　　　　　キャッシュ ----
    const ctx = usage.context
    const ttl = cacheTtlMs(usage.rateLimits)
    const cacheView = (() => {
      const r = lastRequest
      if (!r) return null
      const state = cacheStateOf(r, ttl, now)
      const hit = Math.round(cacheHitPct(r))
      const left = r.at + ttl - now
      const text =
        state === 'expired'
          ? `キャッシュ 期限切れ · 次は ${formatTokens(r.read + r.write + r.fresh)} を読み直し`
          : state === 'missed'
            ? `キャッシュ ${hit}% · 外れ（読み直し）`
            : `キャッシュ ${hit}% · ${formatRemaining(left).replace('あと', '残り')}`
      const color = state === 'warm' ? OK : state === 'expiring' ? WARN : DANGER
      return (
        <Text color={color} dimColor={state === 'warm'} bold={state !== 'warm'}>
          {state === 'warm' ? text : `⚠ ${text}`}
        </Text>
      )
    })()
    const line3 = (
      <Box key="l3" flexDirection="row" justifyContent="space-between" flexWrap="wrap">
        <Box flexDirection="row" columnGap={1}>
          {label('コンテキスト')}
          {ctx.percent !== undefined ? bar('ctx', ctx.percent) : <Text dimColor>{'━'.repeat(barWidth)}</Text>}
          {ctx.percent !== undefined ? pctText(ctx.percent) : <Text dimColor>{'   —'}</Text>}
          <Text dimColor>{`${formatTokens(ctx.tokens ?? 0)} / ${formatTokens(ctx.window)}`}</Text>
        </Box>
        {cacheView}
      </Box>
    )

    // ---- 4・5行目：5時間枠／週間枠（見通しラベル・予測の点線・リセットまでの時間） ----
    const BADGE: Record<Verdict, { text: string; color: string }> = {
      ok: { text: '✓ 余力あり', color: OK },
      tight: { text: '△ 上限接近', color: WARN },
      over: { text: '⚠ 上限見込み', color: DANGER },
      hit: { text: '⛔ 上限到達', color: DANGER },
    }
    const rateLine = (key: string, name: string, limit: SessionRateLimit | undefined) => {
      if (!limit) return null
      const o = outlook(limit, now)
      const v = o ? verdictOf(limit, o) : undefined
      const resetAt = limit.resetsAt ? new Date(limit.resetsAt) : undefined
      const reset =
        resetAt && !Number.isNaN(resetAt.getTime())
          ? `↻ ${formatTime(resetAt, limit.kind)}（${formatRemaining(resetAt.getTime() - now)}）`
          : ''
      // ラベルの横の一言：いつ届くか、リセット時にどこまで行くか
      const detail = !o || !v
        ? <Text dimColor>{'見通しは集計中'}</Text>
        : v === 'hit'
          ? <Text color={DANGER}>{'リセットまで待ち'}</Text>
          : v === 'over' && o.fullAt !== null
            ? <Text color={DANGER} bold>{`${formatTime(new Date(o.fullAt), limit.kind)}頃に到達`}</Text>
            : <Text dimColor>{`リセット時 約${Math.round(o.atReset)}%`}</Text>
      return (
        <Box key={key} flexDirection="row" columnGap={1} flexWrap="wrap">
          {label(name)}
          {bar(`${key}-bar`, limit.percentUsed, o && v !== 'hit' ? o.atReset : undefined)}
          {pctText(limit.percentUsed)}
          {v ? (
            <Text backgroundColor={BADGE[v].color} color={ON_BADGE} bold>
              {` ${BADGE[v].text} `}
            </Text>
          ) : null}
          {detail}
          {reset ? <Text dimColor>{` ${reset}`}</Text> : null}
        </Box>
      )
    }
    const line4 = rateLine('five', '5時間', findLimit(usage.rateLimits, 'five_hour'))
    const line5 = rateLine('week', '週間', findLimit(usage.rateLimits, 'seven_day'))

    // 自分より後ろの mod が描くものも残す
    const theirs = await next(e)

    const body = (
      <Box flexDirection="column">
        {line1}
        {line2}
        {line3}
        {line4}
        {line5}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {framed ? (
          <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column">
            {body}
          </Box>
        ) : (
          body
        )}
        {theirs}
      </Box>
    )
  })
}
