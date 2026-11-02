import { expect, test } from 'claude-code/testing'

import { applyTaskCreate, applyTaskUpdate, applyTodoWrite, EMPTY_BOARD, isAllDone, summarize } from '../hooks/tasks.ts'

const todo = (content: string, status: 'pending' | 'in_progress' | 'completed') => ({
  content,
  status,
  activeForm: `${content}中`,
})

test('TodoWrite：時刻を引き継ぎながらリストを置き換える', () => {
  let b = applyTodoWrite(EMPTY_BOARD, [todo('調査', 'in_progress'), todo('修正', 'pending')], 1000)
  expect(b.startedAt).toBe(1000)
  expect(b.items[0]!.startedAt).toBe(1000)
  b = applyTodoWrite(b, [todo('調査', 'completed'), todo('修正', 'in_progress')], 5000)
  expect(b.items[0]!.startedAt).toBe(1000)
  expect(b.items[0]!.doneAt).toBe(5000)
  expect(b.items[1]!.startedAt).toBe(5000)
  const s = summarize(b)
  expect(s.done).toBe(1)
  expect(s.pct).toBe(50)
  expect(s.running[0]!.active).toBe('修正中')
  b = applyTodoWrite(b, [todo('調査', 'completed'), todo('修正', 'completed')], 9000)
  expect(isAllDone(b)).toBe(true)
  expect(b.finishedAt).toBe(9000)
  // 全部終わったあとに新しい作業が始まったら、ボードを作り直す
  b = applyTodoWrite(b, [todo('次の作業', 'in_progress')], 20000)
  expect(b.items).toHaveLength(1)
  expect(b.startedAt).toBe(20000)
  expect(b.finishedAt).toBeNull()
})

test('TaskCreate / TaskUpdate：1項目ずつ追加・更新・削除する', () => {
  let b = applyTaskCreate(EMPTY_BOARD, { id: '1', subject: 'テストを書く', activeForm: 'テストを書いています' }, 100)
  b = applyTaskCreate(b, { id: '2', subject: 'README' }, 200)
  expect(b.items).toHaveLength(2)
  b = applyTaskUpdate(b, { taskId: '1', status: 'in_progress' }, 300)
  expect(summarize(b).running[0]!.active).toBe('テストを書いています')
  b = applyTaskUpdate(b, { taskId: '2', status: 'deleted' }, 400)
  expect(b.items).toHaveLength(1)
  b = applyTaskUpdate(b, { taskId: '1', status: 'completed' }, 900)
  expect(isAllDone(b)).toBe(true)
  expect(b.items[0]!.doneAt! - b.items[0]!.startedAt!).toBe(600)
  // 知らない ID の更新は無視する
  expect(applyTaskUpdate(b, { taskId: '99', status: 'completed' }, 1000)).toBe(b)
})

const PANE = {
  component: 'Pane',
  requestId: 'cockpit',
  props: {
    title: 'cockpit',
    isFocused: false,
    bodyColumns: 46,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('パネルにタスクの進み具合が出る（ターミナル・デスクトップ両方）', async ($, on) => {
  on('clock.now', () => ({ value: 60_000 }))
  // ツールは実行せず、成功したことにする
  on('tool.call', () => ({ result: {} as never }))
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: '既存コードを調査する', status: 'completed', activeForm: '調査中' },
      { content: 'APIのエラー処理を修正する', status: 'in_progress', activeForm: 'APIのエラー処理を修正中' },
      { content: 'テストを追加する', status: 'pending', activeForm: 'テストを追加中' },
    ],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cockpit', surface, ...PANE })
    expect(await ui.find({ type: 'Button', text: /TASKS 1\/3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '33%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'APIのエラー処理を修正中' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'テストを追加する' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '既存コードを調査する' })).toBeDefined()
    // タブを切り替える
    await ui.press({ key: 'tab-artifacts' })
    expect(await ui.find({ type: 'Text', text: /自動で集まります/ })).toBeDefined()
    await ui.press({ key: 'tab-tasks' })
    await ui.unmount()
  }
})
