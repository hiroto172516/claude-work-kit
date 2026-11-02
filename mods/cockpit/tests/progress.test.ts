import { expect, test } from 'claude-code/testing'

import { toTodos } from '../hooks/register.tsx'

const PANE = {
  component: 'Pane',
  requestId: 'cockpit',
  props: {
    title: 'cockpit',
    isFocused: false,
    bodyColumns: 46,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('道具に渡された計画を整える：形のおかしい項目は捨てる', () => {
  const todos = toTodos({
    tasks: [
      { title: '調査する', status: 'completed' },
      { title: '修正する', status: 'in_progress', active: '修正中' },
      { title: '', status: 'pending' },
      { title: 'テスト', status: 'unknown' },
    ],
  })
  expect(todos).toEqual([
    { content: '調査する', status: 'completed', activeForm: '調査する' },
    { content: '修正する', status: 'in_progress', activeForm: '修正中' },
  ])
  expect(toTodos({})).toEqual([])
})

test('Claude が進捗報告の道具を使うと、TASKS タブに計画と進み具合が出る', async ($, on) => {
  on('clock.now', () => ({ value: 60_000 }))
  const ran = await $.tool.call({
    tool: 'mcp__cockpit__progress',
    tasks: [
      { title: '既存コードを調べる', status: 'completed' },
      { title: 'エラー処理を直す', status: 'in_progress', active: 'エラー処理を直し中' },
      { title: 'テストを追加する', status: 'pending' },
    ],
  } as never)
  expect(ran.result).toBe('Shown to the user: 1/3 completed.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cockpit', surface, ...PANE })
    expect(await ui.find({ type: 'Button', text: /TASKS 1\/3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'エラー処理を直し中' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'テストを追加する' })).toBeDefined()
    await ui.unmount()
  }
})

test('道具は「名前だけの後読み込み」にせず、説明ごと最初から見せる', async ($, on) => {
  on('tool.describe', (_$, e) => ({ description: e.description, isDeferred: true }))
  const r = await $.tool.describe({
    tool: 'mcp__cockpit__progress',
    description: 'Show your plan',
    isDeferred: true,
    provider: { kind: 'plugin', name: 'cockpit' },
  } as never)
  expect(r.isDeferred).toBe(false)
  expect(r.description).toBe('Show your plan')
})

test('設定でオフにすると、道具を使っても何も表示しない', { options: { progressTool: false } }, async ($, on) => {
  on('clock.now', () => ({ value: 60_000 }))
  const ran = await $.tool.call({
    tool: 'mcp__cockpit__progress',
    tasks: [{ title: '調べる', status: 'in_progress' }],
  } as never)
  expect(String(ran.result)).toMatch(/turned off/)
  const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /タスク待機中/ })).toBeDefined()
  await ui.unmount()
})
