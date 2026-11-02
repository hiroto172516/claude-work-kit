import type { TaskBoard, TaskItem, TaskStatus } from '../types'

// タスクボードの計算（画面に依存しない部分）

export const EMPTY_BOARD: TaskBoard = { items: [], startedAt: null, finishedAt: null }

export type TodoInput = { content: string; status: TaskStatus; activeForm: string }

// 状態が変わったときに、進行中・完了の時刻を記録する
function stamp(item: TaskItem, status: TaskStatus, now: number): TaskItem {
  const next: TaskItem = { ...item, status }
  if (status !== 'pending' && next.startedAt === undefined) next.startedAt = now
  if (status === 'completed' && next.doneAt === undefined) next.doneAt = now
  if (status !== 'completed') delete next.doneAt
  return next
}

// 全部終わっているか（空なら「終わっていない」扱い）
export function isAllDone(board: TaskBoard): boolean {
  return board.items.length > 0 && board.items.every(i => i.status === 'completed')
}

// 開始・完了の時刻を、項目の状態に合わせて整える
function settle(board: TaskBoard, now: number): TaskBoard {
  const done = isAllDone(board)
  return {
    ...board,
    startedAt: board.items.length === 0 ? null : (board.startedAt ?? now),
    finishedAt: done ? (board.finishedAt ?? now) : null,
  }
}

// 前のリストが全部終わったあとに新しい作業が始まったら、ボードを作り直す
function freshIfFinished(board: TaskBoard): TaskBoard {
  return isAllDone(board) ? EMPTY_BOARD : board
}

// TodoWrite：リスト全体が送られてくるので、内容ごとに時刻を引き継いで置き換える
export function applyTodoWrite(board: TaskBoard, todos: readonly TodoInput[], now: number): TaskBoard {
  const hasOpen = todos.some(t => t.status !== 'completed')
  const base = hasOpen ? freshIfFinished(board) : board
  const before = new Map(base.items.filter(i => i.source === 'todo').map(i => [i.key, i]))
  const todoItems = todos.map(t => {
    const prev = before.get(t.content)
    const item: TaskItem = prev ?? { key: t.content, source: 'todo', title: t.content, active: t.activeForm, status: 'pending' }
    return stamp({ ...item, title: t.content, active: t.activeForm || t.content }, t.status, now)
  })
  const others = base.items.filter(i => i.source !== 'todo')
  return settle({ ...base, items: [...others, ...todoItems] }, now)
}

// TaskCreate：1項目ずつ追加される
export function applyTaskCreate(
  board: TaskBoard,
  task: { id: string; subject: string; activeForm?: string },
  now: number,
): TaskBoard {
  const base = freshIfFinished(board)
  const key = `task:${task.id}`
  if (base.items.some(i => i.key === key)) return base
  const item: TaskItem = {
    key,
    source: 'task',
    title: task.subject,
    active: task.activeForm || task.subject,
    status: 'pending',
  }
  return settle({ ...base, items: [...base.items, item] }, now)
}

// TaskUpdate：状態や題名の変更。deleted は取り除く
export function applyTaskUpdate(
  board: TaskBoard,
  update: { taskId: string; subject?: string; activeForm?: string; status?: TaskStatus | 'deleted' },
  now: number,
): TaskBoard {
  const key = `task:${update.taskId}`
  if (!board.items.some(i => i.key === key)) return board
  const items =
    update.status === 'deleted'
      ? board.items.filter(i => i.key !== key)
      : board.items.map(i => {
          if (i.key !== key) return i
          const renamed = {
            ...i,
            title: update.subject ?? i.title,
            active: update.activeForm ?? i.active,
          }
          return update.status && update.status !== 'deleted' ? stamp(renamed, update.status, now) : renamed
        })
  return settle({ ...board, items }, now)
}

// 進み具合のまとめ
export function summarize(board: TaskBoard) {
  const total = board.items.length
  const done = board.items.filter(i => i.status === 'completed').length
  return {
    total,
    done,
    pct: total === 0 ? 0 : (done / total) * 100,
    running: board.items.filter(i => i.status === 'in_progress'),
    pending: board.items.filter(i => i.status === 'pending'),
    // 完了は新しい順
    completed: board.items
      .filter(i => i.status === 'completed')
      .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)),
  }
}
