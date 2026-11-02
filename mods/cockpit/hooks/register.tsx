import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type {
  Artifact,
  ArtifactKind,
  CockpitTab,
  SecEvent,
  SecLevel,
  SecLog,
  SecSession,
  SecView,
  TaskBoard,
  TaskItem,
} from '../types'
import { CATEGORY_LABEL, classify, dayKey, EMPTY_LOG, maskSecrets, migrateLog, record, timeline } from './security.ts'
import type { Verdict } from './security.ts'
import {
  addArtifacts,
  baseName,
  groupByDir,
  extractCommands,
  extractToolUrls,
  extractUrls,
  grouped,
  lineCount,
  removeArtifact,
  shortPath,
  shortUrl,
  togglePin,
  urlGroup,
} from './artifacts.ts'
import type { NewArtifact } from './artifacts.ts'
import { applyTaskCreate, applyTaskUpdate, applyTodoWrite, EMPTY_BOARD, isAllDone, summarize } from './tasks.ts'
import {
  barCells as ctxCells,
  chunk,
  contextAfter,
  createLedger,
  fmtTokens,
  gist,
  inputStack,
  promptStarted,
  stepEnded,
  stepStarted,
  systemTokens,
  toolAnswered,
} from './turns.ts'
import type { Block, Ledger, Turn } from './turns.ts'

// ---- 配色：黒地に映える、青を基調にしたハッカーの端末画面風 ----
const HUD = {
  primary: '#4DA3FF', // 基調の青
  cyan: '#7AE7FF',
  amber: '#FFB547',
  red: '#FF5C7A',
  violet: '#B49BFF',
  text: '#D6E4FF', // 本文（やや青みがかった白）
  dim: '#6E85A8', // 補足（くすんだ青）
  grid: '#23395B', // 罫線（暗い紺）
}

// 表示幅（全角は2）
function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1
  return w
}


const PANE = 'cockpit'
const PANE_COLUMNS = 48

const tabAtom = atom({ plugin: 'cockpit', key: 'tab' } as const, 'tasks' as CockpitTab)
const boardAtom = atom({ plugin: 'cockpit', key: 'board' } as const, EMPTY_BOARD as TaskBoard)
const artifactsAtom = atom({ plugin: 'cockpit', key: 'artifacts' } as const, [] as Artifact[])
const showRefsAtom = atom({ plugin: 'cockpit', key: 'showRefs' } as const, false)

const secLogAtom = atom({ plugin: 'cockpit', key: 'secLog' } as const, EMPTY_LOG as SecLog)
const EMPTY_SESSION: SecSession = { recent: [], flagged: [], hosts: {}, counts: { ok: 0, warn: 0, alert: 0 } }
const secSessionAtom = atom({ plugin: 'cockpit', key: 'secSession' } as const, EMPTY_SESSION)
const expandedAtom = atom({ plugin: 'cockpit', key: 'expanded' } as const, [] as string[])
const secViewAtom = atom({ plugin: 'cockpit', key: 'secView' } as const, 'flagged' as SecView)

// このセッションのプロジェクトの場所（成果物はプロジェクトごとに保存する）と、ホームフォルダ
let root = ''
let home = ''
// このセッションが始まった時刻（このセッションで触ったファイルを目立たせる）
let sessionStartedAt = 0

const TABS: { id: CockpitTab; name: string; hotkey: string }[] = [
  { id: 'tasks', name: 'TASKS', hotkey: '1' },
  { id: 'artifacts', name: 'ARTIFACTS', hotkey: '2' },
  { id: 'security', name: 'SECURITY', hotkey: '3' },
  { id: 'turns', name: 'TURNS', hotkey: '4' },
]


// 84秒 → "1:24"、3725秒 → "1:02:05"
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

async function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'cockpit', columns: PANE_COLUMNS })
}

// ボードを書き換える（失敗しても作業は止めない）
async function changeBoard($: EngineInterface, fn: (board: TaskBoard, now: number) => TaskBoard): Promise<void> {
  try {
    await applyBoard($, fn)
  } catch {
    // 表示のための記録なので、失敗しても作業は止めない
  }
}

// ボードを書き換え、全部終わった瞬間にお知らせを出す
async function applyBoard($: EngineInterface, fn: (board: TaskBoard, now: number) => TaskBoard): Promise<void> {
  const now = await $.clock.now()
  const before = await read($, boardAtom)
  const after = fn(before, now)
  await update($, boardAtom, () => after)
  if (!isAllDone(before) && isAllDone(after) && after.startedAt !== null) {
    const { total } = summarize(after)
    $.ui.toast(`✓ 全タスク完了（${total}件・所要 ${formatElapsed(now - after.startedAt)}）`)
  }
}

// ---- TURNS：AI への問い合わせ1回ごとの内訳（turn-inspector の仕組みを移植） ----
const KEEP_TURNS = 200
let ledger: Ledger = createLedger()
// 最新の問い合わせを自動で開いておくか（自分で開閉したら止める）
let followTurns = true
const openTurns = new Set<number>()

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return ''
  }
}

// 毎回送られる「指示・道具・メモリ」の量を、手元の見積もり（/context と同じ）で更新する
async function refreshSystem($: EngineInterface): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary', columns: PANE_COLUMNS }).catch(() => undefined)
  if (!usage) return
  ledger.window = usage.context.window
  const system = systemTokens(usage.context.breakdown?.categories ?? [])
  if (system !== undefined) ledger.system = system
}

// ---- 成果物トレイ：プロジェクトごとに $.store へ保存し、次のセッションでも見られるようにする ----
function trayKey(): string {
  return `artifacts:${root}`
}

async function loadArtifacts($: EngineInterface): Promise<void> {
  try {
    const saved = await $.store.get(trayKey())
    await update($, artifactsAtom, () => (Array.isArray(saved) ? (saved as Artifact[]) : []))
  } catch {
    // 読めなくても空のトレイで始める
  }
}

// トレイを書き換えて保存する（失敗しても作業は止めない）
async function changeTray($: EngineInterface, fn: (list: Artifact[], now: number) => Artifact[]): Promise<void> {
  try {
    const now = await $.clock.now()
    // 別のセッションが同じプロジェクトに書いた分（追加・削除・★）を取り込んでから、
    // 今回の操作だけを当てる。どちらかの一覧を丸ごと採用しないので、消したものが復活しない
    const saved = await $.store.get(trayKey())
    const base = Array.isArray(saved) ? (saved as Artifact[]) : await read($, artifactsAtom)
    const next = fn(base, now)
    await update($, artifactsAtom, () => next)
    await $.store.set(trayKey(), next)
  } catch {
    // 表示のための記録なので、失敗しても作業は止めない
  }
}

async function addToTray($: EngineInterface, items: NewArtifact[]): Promise<void> {
  if (items.length === 0) return
  await changeTray($, (list, now) => addArtifacts(list, items, now))
}

// ---- セキュリティ監視：⛔・⚠ の記録と日ごとの件数を $.store に7日分残す（全プロジェクト共通） ----
const SEC_KEY = 'security'

async function loadSecurity($: EngineInterface): Promise<void> {
  try {
    const saved = await $.store.get(SEC_KEY)
    if (saved && typeof saved === 'object') {
      // 判定ルールが新しくなっていたら、保存済みの記録を判定し直して保存し直す
      const log = migrateLog(saved as SecLog, home)
      if (log !== saved) await $.store.set(SEC_KEY, log)
      await update($, secLogAtom, () => log)
    }
  } catch {
    // 読めなくても空の記録で始める
  }
}

// 設定のフックが止めた呼び出しの ID（止められた呼び出しは「失敗」ではなく「ブロック済み」と表示する）
const blockedIds = new Set<string>()

function outcomeOf(id: string, ran: { deny?: string; isError?: boolean; text?: string }): SecEvent['outcome'] {
  if (ran.deny !== undefined) return 'blocked'
  if (blockedIds.delete(id)) return 'blocked'
  if (!ran.isError) return 'done'
  // 確認画面で「いいえ」を選んだときなど、拒否されたことが文面で分かる場合
  return /\b(denied|rejected|blocked|not allowed|permission)\b|hook/i.test(ran.text ?? '') ? 'blocked' : 'failed'
}

// まだ保存していない記録。数秒ごとにまとめて書き込む（ツールを使うたびに書き込まない）
let pending: SecEvent[] = []

async function recordSecurity($: EngineInterface, event: SecEvent): Promise<void> {
  try {
    pending.push(event)
    // 画面は、保存を待たずにすぐ更新する
    await update($, secLogAtom, log => record(log, event))
    await update($, secSessionAtom, prev => {
      const s = { ...EMPTY_SESSION, ...prev }
      return {
        recent: [event, ...s.recent].slice(0, 100),
        flagged: event.level === 'ok' ? s.flagged : [event, ...s.flagged].slice(0, 200),
        hosts: event.host ? { ...s.hosts, [event.host]: (s.hosts[event.host] ?? 0) + 1 } : s.hosts,
        counts: { ...s.counts, [event.level]: s.counts[event.level] + 1 },
      }
    })
    if (event.level === 'alert') {
      const how = event.outcome === 'blocked' ? '（ブロック済み）' : event.outcome === 'failed' ? '（失敗）' : ''
      $.ui.toast(`⛔ ${CATEGORY_LABEL[event.category]}：${event.target.slice(0, 60)}${how}`, { timeoutMs: 8_000 })
    }
  } catch {
    // 監視の記録に失敗しても、作業は止めない
  }
}

// 溜まった記録を保存する。保存されている最新の記録に「差分として」足すので、
// 同時に開いている別のセッションの記録を上書きしない
async function flushSecurity($: EngineInterface): Promise<void> {
  if (pending.length === 0) return
  const batch = pending
  pending = []
  try {
    const saved = await $.store.get(SEC_KEY)
    let log = saved && typeof saved === 'object' ? migrateLog(saved as SecLog, home) : EMPTY_LOG
    for (const ev of batch) log = record(log, ev)
    await $.store.set(SEC_KEY, log)
    await update($, secLogAtom, () => log)
  } catch {
    // 保存に失敗したら、次の機会にもう一度
    pending = [...batch, ...pending]
  }
}

// ---- 進捗報告の道具：Claude が計画と進捗を TASKS タブに報告するための、cockpit 専用の道具 ----
// 使い方は道具の説明文だけで伝える（システムプロンプトや CLAUDE.md には何も足さない）
const PROGRESS_TOOL = 'progress'
const PROGRESS_DESCRIPTION = [
  "Show your plan and live progress to the user in the cockpit side panel (TASKS tab).",
  "Use it for any request that takes 3 or more distinct steps, or when the user asks you to plan:",
  "call it once before you start, listing every step (the first one 'in_progress', the rest 'pending'),",
  "then call it again whenever a step starts or finishes. Always send the FULL list, keep exactly one step",
  "'in_progress' while working, and mark every step 'completed' when you are done.",
  "Write 'title' as a short step name in the user's language, and 'active' as the present-progressive",
  "form shown while the step runs (e.g. title 'テストを追加する', active 'テストを追加中').",
  "Skip it for single-step requests and plain questions. It only updates the panel; it changes nothing else.",
].join(' ')
const PROGRESS_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      description: 'The whole plan, in order.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short step name in the user\'s language.' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          active: { type: 'string', description: 'Present-progressive form shown while the step runs.' },
        },
        required: ['title', 'status'],
      },
    },
  },
  required: ['tasks'],
}

type ProgressInput = { tasks?: { title?: unknown; status?: unknown; active?: unknown }[] }

// 道具に渡された計画を、タスクボードの形に直す（形のおかしい項目は捨てる）
export function toTodos(input: ProgressInput) {
  const STATUSES = ['pending', 'in_progress', 'completed'] as const
  return (Array.isArray(input.tasks) ? input.tasks : [])
    .filter(t => typeof t?.title === 'string' && t.title.trim() && STATUSES.includes(t.status as never))
    .slice(0, 30)
    .map(t => ({
      content: String(t.title).trim().slice(0, 120),
      status: t.status as (typeof STATUSES)[number],
      activeForm: typeof t.active === 'string' && t.active.trim() ? t.active.trim().slice(0, 120) : String(t.title).trim(),
    }))
}

export const register: Register = (on, options) => {
  const isProgressToolOn = options.progressTool !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cockpit',
      description: 'cockpit パネルを開く（close で閉じる、1〜3 でタブを選ぶ、clear で成果物を空にする）',
      immediate: true,
    })
    root = await $.session.root()
    sessionStartedAt = await $.clock.now()
    home = /^\/Users\/[^/]+/.exec(root)?.[0] ?? /^\/home\/[^/]+/.exec(root)?.[0] ?? ''
    await loadArtifacts($)
    await loadSecurity($)
    if (isProgressToolOn) await $.tool.register({ name: PROGRESS_TOOL, description: PROGRESS_DESCRIPTION, inputSchema: PROGRESS_SCHEMA })
    // TURNS：新しいセッションの最初の問い合わせから「毎回送られる量」を正確に測る
    ledger = createLedger()
    openTurns.clear()
    followTurns = true
    ledger.isFresh = (await $.session.messages().catch(() => [1])).length === 0
    await refreshSystem($)
    // 起動時に自動で開く（ターミナルが狭いときは、広げたときに出る）
    void openPane($)
    // 進行中のタスクがある間は、経過時間とくるくる回る印を1秒ごとに進める
    $.clock.every(1_000, () => void tick($))
    // セキュリティの記録は5秒ごとにまとめて保存する
    $.clock.every(5_000, () => void flushSecurity($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await flushSecurity($)
    return next(e)
  })

  // /clear・/resume・/branch のあとは $.state が初期値に戻るので、保存分を読み直す
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    root = await $.session.root()
    // /clear は新しい会話の始まりなので、それより前の成果物は「過去の分」として扱う
    if (e.source === 'clear') sessionStartedAt = await $.clock.now()
    await loadArtifacts($)
    await loadSecurity($)
    return next(e)
  })

  on('command.run', { command: 'cockpit' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') {
      await changeTray($, list => list.filter(a => a.pinned))
      return { text: '成果物トレイを空にしました（★固定したものは残しています）' }
    }
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return {}
    }
    const tab = TABS.find(t => t.hotkey === arg || t.id === arg)
    if (tab) await update($, tabAtom, () => tab.id)
    await openPane($)
    return {}
  })

  // ---- タスクボード：Claude のやることリストを読み取る（サブエージェント分は除く） ----
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (!e.agentId && ran.deny === undefined && !ran.isError) {
      await changeBoard($, (board, now) => applyTodoWrite(board, e.todos, now))
    }
    return ran
  })

  // 進捗報告の道具は、名前だけの「後から読み込む道具」にせず、説明ごと最初から Claude に見せる
  // （後読み込みだと説明文が読まれず、使い方が伝わらないため）
  on('tool.describe', { tool: 'mcp__cockpit__progress' }, async ($, e, next) => {
    const described = await next(e)
    return isProgressToolOn ? { ...described, isDeferred: false } : described
  })

  // 進捗報告の道具への応答：タスクボードを書き換えて、短い返事を返す
  on('tool.call', { tool: 'mcp__cockpit__progress' }, async ($, e) => {
    if (!isProgressToolOn) return { result: 'The progress tool is turned off in cockpit settings; continue without it.' }
    const todos = toTodos(e as unknown as ProgressInput)
    if (todos.length === 0) return { result: 'No valid steps were given; send tasks as [{ title, status, active }].' }
    await changeBoard($, (board, now) => applyTodoWrite(board, todos, now))
    const done = todos.filter(t => t.status === 'completed').length
    return { result: `Shown to the user: ${done}/${todos.length} completed.` }
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (!e.agentId && ran.deny === undefined && !ran.isError && ran.result?.task) {
      const task = { id: ran.result.task.id, subject: e.subject, activeForm: e.activeForm }
      await changeBoard($, (board, now) => applyTaskCreate(board, task, now))
    }
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (!e.agentId && ran.deny === undefined && !ran.isError) {
      await changeBoard($, (board, now) => applyTaskUpdate(board, e, now))
    }
    return ran
  })


  // コマンドの実行結果からは、手元のサーバーと GitHub のプルリクエストの URL だけ拾う
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (!e.agentId && ran.deny === undefined) {
      const r = ran.result as { stdout?: string; stderr?: string } | undefined
      const out = r ? `${r.stdout ?? ''}\n${r.stderr ?? ''}` : (ran.text ?? '')
      await addToTray($, extractToolUrls(out).map(value => ({ kind: 'url' as const, value })))
    }
    return ran
  })

  // Claude が作った・書き換えたファイル
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const existed = await $.fs.exists(e.file_path).catch(() => true)
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      const change = { isNew: !existed, added: lineCount(e.content), removed: 0 }
      await addToTray($, [{ kind: 'file', value: e.file_path, change }])
    }
    return ran
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      const change = { isNew: false, added: lineCount(e.new_string), removed: lineCount(e.old_string) }
      await addToTray($, [{ kind: 'file', value: e.file_path, change }])
    }
    return ran
  })

  // 調べ物で読んだページは「参考」として控える
  on('tool.call', { tool: 'WebFetch' }, async ($, e, next) => {
    const ran = await next(e)
    if (!e.agentId && ran.deny === undefined && !ran.isError) {
      await addToTray($, extractUrls(e.url).map(value => ({ kind: 'ref' as const, value })))
    }
    return ran
  })

  // ---- セキュリティ監視（と TURNS の記録）：すべてのツール呼び出しを分類して記録する（見るだけで、止めはしない） ----
  // 設定のフック（秘密情報の保護など）が止めた呼び出しを覚えておく
  on('classic.PreToolUse', async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined) blockedIds.add(e.tool_use_id)
    return r
  })

  on('tool.call', async ($, e, next) => {
    let verdict: Verdict | undefined
    try {
      verdict = classify(String(e.tool), e as unknown as Record<string, unknown>, root, home)
    } catch {
      verdict = undefined
    }
    const ran = await next(e)
    // TURNS：道具の結果は、次の問い合わせで AI に送られる新しい入力（サブエージェント分は除く）
    if (e.agentId === undefined) {
      const text = ran.deny ?? ran.text ?? (ran.result === undefined ? '' : safeJson(ran.result))
      toolAnswered(ledger, String(e.tool), text.length, ran.deny !== undefined || ran.isError === true)
    }
    if (verdict) {
      const event: SecEvent = {
        id: e.tool_use_id,
        at: await $.clock.now(),
        level: verdict.level,
        category: verdict.category,
        tool: String(e.tool),
        target: maskSecrets(verdict.target).slice(0, 300),
        host: verdict.host,
        outcome: outcomeOf(e.tool_use_id, ran),
        byAgent: e.agentId !== undefined,
      }
      await recordSecurity($, event)
    }
    return ran
  })

  // ---- TURNS：問い合わせごとの記録（見るだけで、何も変えない） ----
  on('turn.start', async ($, e, next) => {
    promptStarted(ledger, e.turnId, e.text)
    return next(e)
  })

  // 問い合わせ1回 = 1ターン。流れてくる返答から、考えた量・文章・道具の呼び出しを数える（成果物の抽出もここで行う）
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const turn = stepStarted(ledger, e.turnId, e.index, e.model, KEEP_TURNS)
    if (followTurns) {
      openTurns.clear()
      openTurns.add(turn.n)
    }
    $.ui.invalidate('ui.render')
    const names = new Map<number, string>()
    const stream = next(e)
    for await (const c of stream) {
      let isNew = false
      if (c.kind === 'thinking') isNew = chunk(turn, c.index, 'thinking', c.text)
      else if (c.kind === 'text') isNew = chunk(turn, c.index, 'text', c.text)
      else if (c.kind === 'tool') {
        names.set(c.index, c.name)
        isNew = chunk(turn, c.index, 'tool_use', c.name, c.name)
      } else if (c.kind === 'input') isNew = chunk(turn, c.index, 'tool_use', c.json, names.get(c.index))
      if (isNew) $.ui.invalidate('ui.render')
      yield c
    }
    const r = await stream.result
    stepEnded(ledger, turn, r.usage, r.stopReason)
    $.ui.invalidate('ui.render')
    // 成果物トレイ：Claude の返答から URL とコマンドを拾う
    if (r.answer) {
      await addToTray($, [
        ...extractUrls(r.answer).map(value => ({ kind: 'url' as const, value })),
        ...extractCommands(r.answer).map(value => ({ kind: 'command' as const, value })),
      ])
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      await refreshSystem($)
      $.ui.invalidate('ui.render')
    }
    return r
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    if (e.context.window !== ledger.window) ledger.window = e.context.window
    return r
  })

  // ---- パネルの描画 ----
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const tab = await read($, tabAtom)
    const board = await read($, boardAtom)
    const tray = await read($, artifactsAtom)
    const showRefs = await read($, showRefsAtom)
    const secLog = await read($, secLogAtom)
    const secSession = await read($, secSessionAtom)
    const secView = await read($, secViewAtom)
    const expanded = await read($, expandedAtom)
    const session = { ...EMPTY_SESSION, ...secSession }
    const now = await $.clock.now()
    const width = Math.max(24, e.props.bodyColumns)
    const sum = summarize(board)
    const trayCount = tray.filter(a => a.kind !== 'ref' && (a.pinned || a.at >= sessionStartedAt)).length
    const today = secLog.days[dayKey(now)] ?? { ok: 0, warn: 0, alert: 0 }
    const sc = session.counts

    // 「… ほか xx 件」：押すと残りも表示し、もう一度押すとたたむ
    const isOpen = (key: string) => expanded.includes(key)
    const limit = (key: string, max: number) => (isOpen(key) ? Number.MAX_SAFE_INTEGER : max)
    const more = (key: string, hidden: number) =>
      hidden <= 0 && !isOpen(key) ? null : (
        <Box key={`more-${key}`} paddingLeft={2}>
          <Button
            key={`more:${key}`}
            plain
            dimColor
            label={isOpen(key) ? '▴ たたむ' : `… ほか ${hidden} 件を表示`}
            onPress={() => update($, expandedAtom, list => (list.includes(key) ? list.filter(k => k !== key) : [...list, key]))}
          />
        </Box>
      )
    const hhmm = (at: number) => {
      const d = new Date(at)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }

    // ---- 共通の部品 ----
    // 暗い緑の罫線
    const rule = (key: string, ch = '─') => (
      <Text key={key} color={HUD.grid}>
        {ch.repeat(width)}
      </Text>
    )
    // 見出し：「// 進行中 ──────」
    const heading = (key: string, title: string, color: string, count?: number) => {
      const label = `// ${title}${count !== undefined ? ` ·${count}` : ''} `
      return (
        <Box key={key} flexDirection="row" marginTop={1}>
          <Text color={color} bold>
            {label}
          </Text>
          <Text color={HUD.grid}>{'─'.repeat(Math.max(2, width - displayWidth(label)))}</Text>
        </Box>
      )
    }

    // ---- ヘッダー：ロゴ・稼働表示・タブ ----
    const tabLabel = (id: CockpitTab, name: string) =>
      id === 'tasks' && sum.total > 0
        ? `${name} ${sum.done}/${sum.total}`
        : id === 'artifacts' && trayCount > 0
          ? `${name} ${trayCount}`
          : id === 'security' && sc.alert > 0
            ? `${name} ⛔${sc.alert}`
            : id === 'security' && sc.warn > 0
              ? `${name} ⚠${sc.warn}`
              : name

    const header = (
      <Box key="header" flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            <Text color={HUD.grid}>{'▓▒░ '}</Text>
            <Text color={HUD.primary} bold>
              {'C O C K P I T'}
            </Text>
            <Text color={HUD.grid}>{' ░▒▓'}</Text>
          </Box>
          <Button key="close" plain role="dismiss" dimColor label="×" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          {TABS.map(t => (
            <Button
              key={`tab-${t.id}`}
              plain
              hotkey={t.hotkey}
              dimColor={t.id !== tab}
              label={`${t.id === tab ? '❯' : ' '}[${t.hotkey}]${tabLabel(t.id, t.name)}`}
              onPress={() => update($, tabAtom, () => t.id)}
            />
          ))}
        </Box>
      </Box>
    )

    // ---- タスク ----
    const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    const spin = SPIN[Math.floor(now / 1000) % SPIN.length]!
    const taskRow = (item: TaskItem, mark: string, color: string | undefined, dim: boolean, right: string) => (
      <Box key={`task-${item.key}`} flexDirection="row" justifyContent="space-between" columnGap={1}>
        <Box flexDirection="row" columnGap={1} flexShrink={1}>
          <Text color={color} dimColor={dim}>
            {mark}
          </Text>
          <Text color={dim ? undefined : HUD.text} dimColor={dim} wrap="truncate-end">
            {item.status === 'in_progress' ? item.active : item.title}
          </Text>
        </Box>
        {right ? (
          <Text color={HUD.dim} dimColor={dim}>
            {right}
          </Text>
        ) : null}
      </Box>
    )

    const tasksBody = () => {
      if (sum.total === 0) {
        return (
          <Box flexDirection="column" marginTop={1}>
            <Text color={HUD.primary}>{'> タスク待機中'}</Text>
            <Text dimColor wrap="wrap">
              {'Claude が複数の手順の作業で「やることリスト」を作ると、ここに進み具合が表示されます。'}
            </Text>
          </Box>
        )
      }
      const done = isAllDone(board)
      const barWidth = Math.max(8, width - 26)
      const filled = Math.round((sum.pct / 100) * barWidth)
      const elapsed = board.startedAt === null ? 0 : (board.finishedAt ?? now) - board.startedAt
      const MAX_DONE = 8
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1} marginTop={1}>
            <Text color={HUD.dim}>{'PROG'}</Text>
            <Box flexDirection="row">
              <Text color={HUD.grid}>{'['}</Text>
              <Text color={done ? HUD.primary : HUD.cyan}>{'■'.repeat(filled)}</Text>
              <Text color={HUD.grid}>{'·'.repeat(barWidth - filled)}</Text>
              <Text color={HUD.grid}>{']'}</Text>
            </Box>
            <Text color={done ? HUD.primary : HUD.cyan} bold>
              {`${Math.round(sum.pct)}%`}
            </Text>
            <Text color={HUD.dim}>{`T+${formatElapsed(elapsed)}`}</Text>
          </Box>
          {done ? (
            <Text color={HUD.primary} bold>
              {`✔ ALL TASKS COMPLETE — 全${sum.total}件 完了（所要 ${formatElapsed(elapsed)}）`}
            </Text>
          ) : null}
          {sum.running.length > 0 ? heading('h-run', '進行中', HUD.primary, sum.running.length) : null}
          {sum.running.map(i =>
            taskRow(i, spin, HUD.primary, false, i.startedAt !== undefined ? formatElapsed(now - i.startedAt) : ''),
          )}
          {sum.pending.length > 0 ? heading('h-pend', '未着手', HUD.cyan, sum.pending.length) : null}
          {sum.pending.map(i => taskRow(i, '·', HUD.cyan, false, ''))}
          {sum.completed.length > 0 ? heading('h-done', '完了', HUD.dim, sum.completed.length) : null}
          {sum.completed
            .slice(0, limit('done', MAX_DONE))
            .map(i =>
              taskRow(
                i,
                '✔',
                HUD.primary,
                true,
                i.startedAt !== undefined && i.doneAt !== undefined ? formatElapsed(i.doneAt - i.startedAt) : '',
              ),
            )}
          {more('done', sum.completed.length - Math.min(sum.completed.length, limit('done', MAX_DONE)))}
        </Box>
      )
    }

    // ---- 成果物 ----
    const copy = async (text: string, surface: typeof e.surface) => {
      const r = await $.ui.copy({ text, surface })
      $.ui.toast(r.isCopied ? 'コピーしました' : 'コピーできませんでした')
    }
    const openTarget = async (target: string) => {
      const r = await $.process.run(['open', target], { timeoutMs: 10_000 }).catch(() => null)
      if (!r || r.exitCode !== 0) $.ui.toast('開けませんでした')
    }
    const MAX_ROWS = 6
    const labelRoom = Math.max(12, width - 22)

    const artifactRow = (a: Artifact, grouped = false) => {
      const btn = (kind: string, label: string, onPress: (ev: { surface: typeof e.surface }) => unknown) => (
        <Button key={`${kind}:${a.id}`} plain dimColor label={label} onPress={ev => void onPress(ev)} />
      )
      let icon: { mark: string; color: string }
      let main: string
      let sub: { text: string; color: string } | null = null
      let actions: RenderChildren[]
      if (a.kind === 'file') {
        const c = a.change
        icon = c?.isNew ? { mark: '+', color: HUD.primary } : { mark: '~', color: HUD.amber }
        main = grouped ? baseName(a.value) : shortPath(a.value, root, labelRoom)
        if (c) {
          sub = c.isNew
            ? { text: `新規 +${c.added}`, color: HUD.primary }
            : { text: `変更 +${c.added} −${c.removed}`, color: HUD.amber }
        }
        actions = [btn('open', '開く', () => openTarget(a.value)), btn('copy', '複製', ev => copy(a.value, ev.surface))]
      } else if (a.kind === 'command') {
        const lines = a.value.split('\n')
        icon = { mark: '$', color: HUD.violet }
        main = `${lines[0]}${lines.length > 1 ? ` …(+${lines.length - 1}行)` : ''}`
        actions = [
          btn('copy', '複製', ev => copy(a.value, ev.surface)),
          btn('fill', '入力欄へ', async () => {
            const text = lines.length === 1 ? `!${a.value}` : a.value
            await $.prompt.fill({ text, mode: 'replace' })
          }),
        ]
      } else {
        const group = urlGroup(a.value)
        icon =
          group === 'local'
            ? { mark: '◉', color: HUD.primary }
            : group === 'github'
              ? { mark: '⎇', color: HUD.violet }
              : { mark: '↗', color: HUD.cyan }
        main = shortUrl(a.value, labelRoom)
        actions = [btn('open', '開く', () => openTarget(a.value)), btn('copy', '複製', ev => copy(a.value, ev.surface))]
      }
      return (
        <Box key={`row:${a.id}`} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Box flexDirection="row" columnGap={1} flexShrink={1}>
              <Button
                key={`pin:${a.id}`}
                plain
                dimColor={!a.pinned}
                label={a.pinned ? '★' : '☆'}
                onPress={() => changeTray($, list => togglePin(list, a.id))}
              />
              <Text color={icon.color}>{icon.mark}</Text>
              <Text color={HUD.text} dimColor={a.kind === 'file' && a.at < sessionStartedAt} wrap="truncate-end">
                {main}
              </Text>
            </Box>
            <Box flexDirection="row" columnGap={1}>
              {actions}
              <Button
                key={`rm:${a.id}`}
                plain
                dimColor
                label="×"
                onPress={() => changeTray($, list => removeArtifact(list, a.id))}
              />
            </Box>
          </Box>
          {sub ? <Text color={sub.color} dimColor>{`    ${sub.text}`}</Text> : null}
        </Box>
      )
    }

    // 成果物は「このセッションで見つけたもの（と★固定）」と「過去のセッションの分」に分けて見せる
    type Scope = 'now' | 'past'
    const nowItems = tray.filter(a => a.pinned || a.at >= sessionStartedAt)
    const pastItems = tray.filter(a => !a.pinned && a.at < sessionStartedAt)

    const fileSection = (items: Artifact[], scope: Scope) => {
      const list = grouped(items, 'file')
      if (list.length === 0) return null
      const MAX_FILES = 10
      const key = `${scope}-file`
      let shown = 0
      const rows: RenderChildren[] = []
      for (const g of groupByDir(list.slice(0, limit(key, MAX_FILES)), root)) {
        rows.push(
          <Text key={`dir:${scope}:${g.dir}`} color={HUD.dim} wrap="truncate-start">
            {`▸ ${g.dir}/`}
          </Text>,
        )
        for (const a of g.items) {
          rows.push(<Box key={`in:${a.id}`} paddingLeft={2}>{artifactRow(a, true)}</Box>)
          shown += 1
        }
      }
      return (
        <Box key={`sec:${key}`} flexDirection="column">
          {heading(`h-${key}`, 'ファイル', scope === 'now' ? HUD.primary : HUD.dim, list.length)}
          {rows}
          {more(key, list.length - shown)}
        </Box>
      )
    }

    const traySection = (items: Artifact[], scope: Scope, kind: ArtifactKind, title: string, color: string) => {
      const list = grouped(items, kind)
      if (list.length === 0) return null
      const key = `${scope}-${kind}`
      return (
        <Box key={`sec:${key}`} flexDirection="column">
          {heading(`h-${key}`, title, scope === 'now' ? color : HUD.dim, list.length)}
          {list.slice(0, limit(key, MAX_ROWS)).map(a => artifactRow(a))}
          {more(key, list.length - Math.min(list.length, limit(key, MAX_ROWS)))}
        </Box>
      )
    }

    const artifactsBody = () => {
      if (tray.length === 0) {
        return (
          <Box flexDirection="column" marginTop={1}>
            <Text color={HUD.primary}>{'> 収集待機中'}</Text>
            <Text dimColor wrap="wrap">
              {'Claude が出した URL、作ったファイル、実行を勧めたコマンドが、ここに自動で集まります。'}
            </Text>
          </Box>
        )
      }
      const refs = grouped(nowItems, 'ref')
      const nowShown = nowItems.some(a => a.kind !== 'ref')
      const pastOpen = isOpen('past')
      return (
        <Box flexDirection="column">
          {nowShown ? null : (
            <Box marginTop={1}>
              <Text color={HUD.dim}>{'> このセッションで見つけたものは、まだありません'}</Text>
            </Box>
          )}
          {traySection(nowItems, 'now', 'url', 'URL', HUD.cyan)}
          {fileSection(nowItems, 'now')}
          {traySection(nowItems, 'now', 'command', 'コマンド', HUD.violet)}
          {refs.length > 0 ? (
            <Box key="refs" flexDirection="column">
              <Box flexDirection="row" columnGap={1} marginTop={1}>
                <Text color={HUD.dim}>{`// 参考 ·${refs.length}`}</Text>
                <Button
                  key="toggle-refs"
                  plain
                  dimColor
                  label={showRefs ? '[隠す]' : '[表示]'}
                  onPress={() => update($, showRefsAtom, v => !v)}
                />
              </Box>
              {showRefs ? refs.slice(0, limit('now-ref', MAX_ROWS)).map(a => artifactRow(a)) : null}
              {showRefs ? more('now-ref', refs.length - Math.min(refs.length, limit('now-ref', MAX_ROWS))) : null}
            </Box>
          ) : null}
          {pastItems.length > 0 ? (
            <Box key="past" flexDirection="column" marginTop={1}>
              {rule('past-rule', '┄')}
              <Button
                key="toggle-past"
                plain
                dimColor={!pastOpen}
                label={`${pastOpen ? '▾' : '▸'} 過去のセッションの分 ·${pastItems.length}`}
                onPress={() => update($, expandedAtom, list => (list.includes('past') ? list.filter(k => k !== 'past') : [...list, 'past']))}
              />
              {pastOpen ? traySection(pastItems, 'past', 'url', 'URL', HUD.cyan) : null}
              {pastOpen ? fileSection(pastItems, 'past') : null}
              {pastOpen ? traySection(pastItems, 'past', 'command', 'コマンド', HUD.violet) : null}
              {pastOpen ? traySection(pastItems, 'past', 'ref', '参考', HUD.dim) : null}
            </Box>
          ) : null}
        </Box>
      )
    }

    // ---- セキュリティ ----
    const LEVEL: Record<SecLevel, { tag: string; color: string }> = {
      ok: { tag: '[ OK ]', color: HUD.dim },
      warn: { tag: '[WARN]', color: HUD.amber },
      alert: { tag: '[ALRT]', color: HUD.red },
    }
    const timeOf = (at: number) => {
      const d = new Date(at)
      return dayKey(at) === dayKey(now) ? hhmm(at) : `${d.getMonth() + 1}/${d.getDate()} ${hhmm(at)}`
    }
    const OUTCOME: Record<SecEvent['outcome'], { text: string; color: string } | null> = {
      done: null,
      failed: { text: '→ 失敗', color: HUD.dim },
      blocked: { text: '→ ブロック済み', color: HUD.primary },
    }

    const eventRow = (ev: SecEvent) => {
      const lv = LEVEL[ev.level]
      const out = OUTCOME[ev.outcome]
      const quiet = ev.level === 'ok'
      return (
        <Box key={`ev:${ev.id}`} flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Text color={HUD.dim}>{timeOf(ev.at)}</Text>
            <Text color={lv.color} bold={!quiet}>
              {lv.tag}
            </Text>
            <Text color={quiet ? undefined : lv.color} dimColor={quiet}>
              {CATEGORY_LABEL[ev.category]}
            </Text>
            {ev.byAgent ? <Text color={HUD.violet}>{'🤖'}</Text> : null}
            {out ? <Text color={out.color}>{out.text}</Text> : null}
          </Box>
          <Text color={HUD.grid} wrap="truncate-end">{`  └ ${ev.target || ev.tool}`}</Text>
        </Box>
      )
    }

    const sparkline = () => {
      // 直近3時間：このセッションの操作だけを数える
      const seen = new Set<string>()
      const all = [...session.recent, ...session.flagged].filter(ev => !seen.has(ev.id) && seen.add(ev.id))
      const bins = timeline(all, now, Math.max(12, Math.min(30, width - 16)))
      const peak = Math.max(1, ...bins.map(b => b.count))
      const BARS = '▁▂▃▄▅▆▇█'
      return (
        <Box key="spark" flexDirection="row" columnGap={1}>
          <Text color={HUD.dim}>{'ACT '}</Text>
          <Box flexDirection="row">
            {bins.map((b, i) => (
              <Text key={`bin-${i}`} color={b.count === 0 ? HUD.grid : b.level === 'ok' ? HUD.primary : LEVEL[b.level].color}>
                {b.count === 0 ? '▁' : BARS[Math.min(7, Math.ceil((b.count / peak) * 7))]!}
              </Text>
            ))}
          </Box>
          <Text color={HUD.dim}>{'3h'}</Text>
        </Box>
      )
    }

    const securityBody = () => {
      const VIEWS: { id: SecView; label: string; hotkey: string }[] = [
        { id: 'flagged', label: '警告', hotkey: 'a' },
        { id: 'all', label: '全操作', hotkey: 's' },
        { id: 'hosts', label: '通信先', hotkey: 'd' },
        { id: 'history', label: '履歴7日', hotkey: 'f' },
      ]
      const MAX_EVENTS = 12
      let list: RenderChildren
      if (secView === 'hosts') {
        const hosts = Object.entries(session.hosts).sort((a, b) => b[1] - a[1])
        list =
          hosts.length === 0 ? (
            <Text color={HUD.dim}>{'> 外部との通信はまだありません'}</Text>
          ) : (
            <Box flexDirection="column">
              {hosts.slice(0, limit('hosts', 15)).map(([host, n]) => (
                <Box key={`host:${host}`} flexDirection="row" justifyContent="space-between">
                  <Box flexDirection="row" columnGap={1} flexShrink={1}>
                    <Text color={HUD.cyan}>{'⇄'}</Text>
                    <Text color={HUD.text} wrap="truncate-end">
                      {host}
                    </Text>
                  </Box>
                  <Text color={HUD.dim}>{`×${n}`}</Text>
                </Box>
              ))}
              {more('hosts', hosts.length - Math.min(hosts.length, limit('hosts', 15)))}
            </Box>
          )
      } else {
        const source = secView === 'all' ? session.recent : secView === 'history' ? secLog.events : session.flagged
        const empty =
          secView === 'all'
            ? '> このセッションの操作はまだありません'
            : secView === 'history'
              ? '> ✔ 過去7日間、注意が必要な操作はありません'
              : '> ✔ 異常なし — このセッションで注意が必要な操作はありません'
        const shown = Math.min(source.length, limit(`ev-${secView}`, MAX_EVENTS))
        list =
          source.length === 0 ? (
            <Text color={HUD.primary}>{empty}</Text>
          ) : (
            <Box flexDirection="column">
              {secView === 'history' ? <Text color={HUD.dim}>{'全セッション・全プロジェクトの ⚠・⛔（7日分）'}</Text> : null}
              {source.slice(0, shown).map(eventRow)}
              {more(`ev-${secView}`, source.length - shown)}
            </Box>
          )
      }
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
            <Text color={HUD.primary} bold>
              {'SEC://MONITOR'}
            </Text>
            <Text color={HUD.primary}>{'● 監視中'}</Text>
          </Box>
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row" columnGap={2}>
              <Text color={HUD.dim}>{'今回'}</Text>
              <Text color={HUD.primary}>{`✓ ${sc.ok}`}</Text>
              <Text color={HUD.amber}>{`⚠ ${sc.warn}`}</Text>
              <Text color={HUD.red} bold={sc.alert > 0}>{`⛔ ${sc.alert}`}</Text>
            </Box>
            <Text color={HUD.dim}>{`本日全体 ⚠${today.warn} ⛔${today.alert}`}</Text>
          </Box>
          {sparkline()}
          <Box flexDirection="row" columnGap={2} marginTop={1}>
            {VIEWS.map(v => (
              <Button
                key={`view-${v.id}`}
                plain
                hotkey={v.hotkey}
                dimColor={v.id !== secView}
                label={`${v.id === secView ? '❯' : ' '}${v.label}`}
                onPress={() => update($, secViewAtom, () => v.id)}
              />
            ))}
          </Box>
          {rule('sec-rule', '┄')}
          <Box flexDirection="column">{list}</Box>
        </Box>
      )
    }

    // ---- TURNS ----
    const TURN_COLOR = {
      system: HUD.violet, // 指示・道具・メモリ
      history: HUD.primary, // 過去の会話
      added: HUD.cyan, // 今回新しく入ったもの
      output: HUD.amber, // 出力
    }
    const BLOCK_ICON: Record<Block['kind'], string> = {
      system: '⚙',
      history: '↺',
      user: '❯',
      tool_result: '⇠',
      thinking: '✻',
      text: '¶',
      tool_use: '⚒',
      truncated: '✂',
    }
    const tok = (b: Block) => `${b.isEstimate ? '~' : ''}${fmtTokens(b.tokens)}`

    // 横棒：指示・道具／過去の会話／今回の入力／出力 を色分けし、残りは空き
    const ctxBar = (turn: Turn | undefined, barWidth: number) => {
      const window = ledger.window ?? 0
      if (!turn || turn.input === undefined || window === 0) {
        return <Text color={HUD.grid}>{'·'.repeat(barWidth)}</Text>
      }
      const stack = inputStack(ledger, turn)
      const sumOf = (kinds: Block['kind'][]) => stack.filter(b => kinds.includes(b.kind)).reduce((sum, b) => sum + b.tokens, 0)
      const segs = [sumOf(['system']), sumOf(['history']), sumOf(['user', 'tool_result']), turn.output ?? 0]
      const cells = ctxCells(segs, window, barWidth)
      const colors = [TURN_COLOR.system, TURN_COLOR.history, TURN_COLOR.added, TURN_COLOR.output]
      const used = cells.reduce((sum, c) => sum + c, 0)
      return (
        <Box flexDirection="row">
          {cells.map((n, i) =>
            n > 0 ? (
              <Text key={`seg-${i}`} color={colors[i]}>
                {'■'.repeat(n)}
              </Text>
            ) : null,
          )}
          <Text color={HUD.grid}>{'·'.repeat(Math.max(0, barWidth - used))}</Text>
        </Box>
      )
    }

    const blockLine = (key: string, b: Block, rail: string) => (
      <Box key={key} flexDirection="row" justifyContent="space-between" columnGap={1}>
        <Box flexDirection="row" columnGap={1} flexShrink={1}>
          <Text color={rail}>{'┃'}</Text>
          <Text color={b.isError || b.kind === 'truncated' ? HUD.red : HUD.dim}>{BLOCK_ICON[b.kind]}</Text>
          <Text color={HUD.text} wrap="truncate-end">
            {b.label}
          </Text>
        </Box>
        <Text color={HUD.dim}>{b.kind === 'truncated' ? '' : tok(b)}</Text>
      </Box>
    )

    const turnDetail = (turn: Turn) => {
      if (turn.status === 'streaming') {
        return (
          <Text key={`d-${turn.n}`} color={HUD.dim}>
            {'  ┃ 受信中…'}
          </Text>
        )
      }
      const inputs = inputStack(ledger, turn)
      return (
        <Box key={`d-${turn.n}`} flexDirection="column" paddingLeft={1}>
          <Box flexDirection="row" columnGap={1}>
            <Text color={TURN_COLOR.added}>{'┃'}</Text>
            <Text color={TURN_COLOR.added} bold>
              {`入力 ${fmtTokens(turn.input)}`}
            </Text>
            <Text color={HUD.dim}>{`（キャッシュ ${fmtTokens(turn.cacheRead)}）`}</Text>
          </Box>
          {inputs.map((b, i) => blockLine(`in-${turn.n}-${i}`, b, TURN_COLOR.added))}
          {turn.isCompacted ? <Text color={HUD.amber}>{'┃ この直前に会話が要約された'}</Text> : null}
          <Box flexDirection="row" columnGap={1}>
            <Text color={TURN_COLOR.output}>{'┃'}</Text>
            <Text color={TURN_COLOR.output} bold>
              {`出力 +${fmtTokens(turn.output)}`}
            </Text>
          </Box>
          {turn.answer.map((b, i) => blockLine(`out-${turn.n}-${i}`, b, TURN_COLOR.output))}
          <Text color={HUD.grid}>{`  ${(turn.model ?? '').replace(/^claude-/, '')} · ${turn.stopReason ?? ''}`}</Text>
        </Box>
      )
    }

    const turnRow = (turn: Turn) => {
      const isOpenTurn = openTurns.has(turn.n)
      const after = contextAfter(turn)
      const window = ledger.window ?? 0
      const mini = 8
      const filled = after && window ? Math.max(1, Math.round((after / window) * mini)) : 0
      return (
        <Box key={`t-${turn.n}`} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Button
              key={`turn:${turn.n}`}
              plain
              dimColor={!isOpenTurn}
              label={`${isOpenTurn ? '▾' : '▸'} #${turn.n} ${gist(turn)}`}
              onPress={() => {
                followTurns = false
                if (openTurns.has(turn.n)) openTurns.delete(turn.n)
                else openTurns.add(turn.n)
                $.ui.invalidate('ui.render')
              }}
            />
            <Box flexDirection="row" columnGap={1}>
              <Box flexDirection="row">
                <Text color={turn.status === 'failed' ? HUD.red : HUD.primary}>{'█'.repeat(Math.min(mini, filled))}</Text>
                <Text color={HUD.grid}>{'░'.repeat(Math.max(0, mini - filled))}</Text>
              </Box>
              <Text color={HUD.dim}>{fmtTokens(after).padStart(6)}</Text>
            </Box>
          </Box>
          {isOpenTurn ? turnDetail(turn) : null}
        </Box>
      )
    }

    const turnsBody = () => {
      const turns = ledger.turns
      if (turns.length === 0) {
        return (
          <Box flexDirection="column" marginTop={1}>
            <Text color={HUD.primary}>{'> 問い合わせ待機中'}</Text>
            <Text dimColor wrap="wrap">
              {'Claude が AI に問い合わせるたびに、送った内容（指示・過去の会話・新しい入力）と返ってきた内容の量が、1回ずつここに並びます。'}
            </Text>
          </Box>
        )
      }
      const last = [...turns].reverse().find(t => t.input !== undefined)
      const after = last ? contextAfter(last) : undefined
      const window = ledger.window ?? 0
      const pct = after && window ? Math.round((after / window) * 100) : 0
      const barWidth = Math.max(10, width - 12)
      // 新しい問い合わせが下。古いものは「… ほか」で隠す
      const MAX_TURNS = 12
      const shown = turns.slice(-Math.min(turns.length, limit('turns', MAX_TURNS)))
      const rows: RenderChildren[] = []
      let lastId = ''
      for (const t of shown) {
        if (t.turnId !== lastId) {
          lastId = t.turnId
          const prompt = t.prompt ? t.prompt.replace(/\s+/g, ' ') : '（続き）'
          rows.push(heading(`p-${t.n}`, `❯ ${prompt.length > 30 ? `${prompt.slice(0, 29)}…` : prompt}`, HUD.dim))
        }
        rows.push(turnRow(t))
      }
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1} marginTop={1}>
            <Text color={HUD.dim}>{'CTX'}</Text>
            <Box flexDirection="row">
              <Text color={HUD.grid}>{'['}</Text>
              {ctxBar(last, barWidth)}
              <Text color={HUD.grid}>{']'}</Text>
            </Box>
            <Text color={HUD.primary} bold>{`${pct}%`}</Text>
          </Box>
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row" columnGap={1}>
              <Text color={TURN_COLOR.system}>{'■指示・道具'}</Text>
              <Text color={TURN_COLOR.history}>{'■過去'}</Text>
              <Text color={TURN_COLOR.added}>{'■今回'}</Text>
              <Text color={TURN_COLOR.output}>{'■出力'}</Text>
            </Box>
            <Text color={HUD.dim}>{`${fmtTokens(after)} / ${fmtTokens(window || undefined)}`}</Text>
          </Box>
          {more('turns', turns.length - shown.length)}
          {rows}
          <Box flexDirection="row" columnGap={2} marginTop={1}>
            {followTurns ? (
              <Text color={HUD.dim}>{'● 最新を自動で表示中'}</Text>
            ) : (
              <Button
                key="turns-follow"
                plain
                label="[最新を追う]"
                onPress={() => {
                  followTurns = true
                  openTurns.clear()
                  const newest = ledger.turns.at(-1)
                  if (newest) openTurns.add(newest.n)
                  $.ui.invalidate('ui.render')
                }}
              />
            )}
            <Button
              key="turns-clear"
              plain
              dimColor
              label="[記録を消す]"
              onPress={() => {
                const { window: w, system, baseline } = ledger
                ledger = Object.assign(createLedger(), { window: w, system, baseline })
                openTurns.clear()
                followTurns = true
                $.ui.invalidate('ui.render')
              }}
            />
          </Box>
        </Box>
      )
    }

    // ---- 最下部：プロンプト風の状態表示 ----
    const running = sum.running[0]
    const footer = (
      <Box key="footer" flexDirection="column" marginTop={1}>
        {rule('foot-rule')}
        <Box flexDirection="row" columnGap={1}>
          <Text color={HUD.primary}>{'cockpit:~$'}</Text>
          <Text color={running ? HUD.cyan : HUD.dim} wrap="truncate-end">
            {running ? `exec "${running.active}"` : 'standby'}
          </Text>
          <Text color={HUD.primary}>{Math.floor(now / 1000) % 2 === 0 ? '█' : ' '}</Text>
        </Box>
      </Box>
    )

    const body =
      tab === 'tasks'
        ? tasksBody()
        : tab === 'artifacts'
          ? artifactsBody()
          : tab === 'security'
            ? securityBody()
            : turnsBody()

    return (
      <Box flexDirection="column">
        {header}
        {rule('head-rule', '━')}
        {body}
        {footer}
      </Box>
    )
  })
}

// 進行中のタスクがあるときだけ描き直す
async function tick($: EngineInterface): Promise<void> {
  const board = await read($, boardAtom)
  if (board.items.some(i => i.status === 'in_progress')) $.ui.invalidate('ui.render')
}
