// cockpit が $.state に置く値の型

export type CockpitTab = 'tasks' | 'artifacts' | 'security' | 'turns'

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

// やることリストの1項目
export type TaskItem = {
  // TodoWrite は内容、TaskCreate は "task:<id>" で見分ける
  key: string
  source: 'todo' | 'task'
  title: string
  // 進行中に表示する「〜中」の言い回し
  active: string
  status: TaskStatus
  // 進行中になった時刻・完了した時刻（ミリ秒）
  startedAt?: number
  doneAt?: number
}

// 今のやることリスト全体
export type TaskBoard = {
  items: TaskItem[]
  // 最初の項目ができた時刻と、全部終わった時刻
  startedAt: number | null
  finishedAt: number | null
}

// 成果物トレイの1件
export type ArtifactKind = 'url' | 'file' | 'command' | 'ref'

export type Artifact = {
  // "<kind>:<value>"。同じものはまとめる
  id: string
  kind: ArtifactKind
  // URL・ファイルの場所・コマンド
  value: string
  // 最後に見つかった時刻（ミリ秒）
  at: number
  // ★で固定したもの（古くなっても消さない）
  pinned: boolean
  // ファイルの場合：新規か、増えた・減った行数（だいたい）
  change?: { isNew: boolean; added: number; removed: number }
}

// セキュリティ監視
export type SecLevel = 'ok' | 'warn' | 'alert'
export type SecCategory =
  | 'secret'
  | 'exfil'
  | 'remote_exec'
  | 'privilege'
  | 'force_push'
  | 'wipe'
  | 'network'
  | 'outside'
  | 'delete'
  | 'publish'
  | 'install'
  | 'config'
  | 'safe'

export type SecEvent = {
  id: string
  at: number
  level: SecLevel
  category: SecCategory
  tool: string
  // 対象（ファイル・コマンド・URL）。秘密らしい文字列は伏せてある
  target: string
  host?: string
  // 実行された／失敗した／設定や確認でブロックされた
  outcome: 'done' | 'failed' | 'blocked'
  // サブエージェントの操作か
  byAgent?: boolean
}

// 日ごとの件数（全プロジェクト共通）と、⛔・⚠ の記録（7日分）
export type SecLog = {
  days: Record<string, { ok: number; warn: number; alert: number }>
  events: SecEvent[]
  // どの版の判定ルールで判定した記録か（ルールを直したら、保存済みの記録を判定し直す）
  rulesVersion?: number
}

// このセッションだけの記録：安全なものも含む直近の操作と、通信先ごとの回数
export type SecSession = {
  recent: SecEvent[]
  // このセッションの ⛔・⚠（全操作の直近100件とは別に、多めに残す）
  flagged: SecEvent[]
  hosts: Record<string, number>
  counts: { ok: number; warn: number; alert: number }
}

// flagged・all・hosts はこのセッションだけ、history は全セッションの7日分
export type SecView = 'flagged' | 'all' | 'hosts' | 'history'

declare module 'claude-code' {
  interface PluginState {
    cockpit: {
      tab: CockpitTab
      board: TaskBoard
      artifacts: Artifact[]
      showRefs: boolean
      secLog: SecLog
      secSession: SecSession
      secView: SecView
      // 「… ほか xx 件」を展開している一覧
      expanded: string[]
    }
  }
}
