import { expect, mock, test } from 'claude-code/testing'

import {
  addArtifacts,
  extractCommands,
  extractToolUrls,
  extractUrls,
  CAPS,
  groupByDir,
  lineCount,
  maskUrl,
  togglePin,
  urlGroup,
} from '../hooks/artifacts.ts'

test('URL を拾う：句読点やかっこを外し、鍵らしい値は伏せる', () => {
  const text = 'こちらです（https://example.com/a?x=1）。PR は https://github.com/o/r/pull/12. 開発用は http://localhost:3000/ です、'
  expect(extractUrls(text)).toEqual(['https://example.com/a?x=1', 'https://github.com/o/r/pull/12', 'http://localhost:3000/'])
  expect(maskUrl('https://a.dev/x?token=abc123&page=2')).toBe('https://a.dev/x?token=****&page=2')
  expect(urlGroup('http://127.0.0.1:8080')).toBe('local')
  expect(urlGroup('https://github.com/o/r')).toBe('github')
  expect(urlGroup('https://example.com')).toBe('web')
})

test('コマンド出力からは、手元のサーバーと PR の URL だけ拾う', () => {
  const out = 'Local: http://localhost:5173/\nDocs: https://vitejs.dev\nCreated https://github.com/o/r/pull/7'
  expect(extractToolUrls(out)).toEqual(['http://localhost:5173/', 'https://github.com/o/r/pull/7'])
})

test('シェル用のコードとして示されたコマンドだけ拾う', () => {
  const text = [
    '次を実行してください。',
    '```bash',
    '$ npm run dev',
    '```',
    '```ts',
    'const x = 1',
    '```',
    '```sh',
    '# コメントは除く',
    'cd app',
    'npm test',
    '```',
  ].join('\n')
  expect(extractCommands(text)).toEqual(['npm run dev', 'cd app\nnpm test'])
})

test('追加：重複はまとめ、古いものから捨てるが★固定は残す', () => {
  let list = addArtifacts([], [{ kind: 'url', value: 'https://a' }], 100)
  list = togglePin(list, 'url:https://a')
  list = addArtifacts(
    list,
    Array.from({ length: CAPS.url + 5 }, (_, i) => ({ kind: 'url' as const, value: `https://x/${i}` })),
    200,
  )
  expect(list.some(a => a.id === 'url:https://a')).toBe(true)
  expect(list.filter(a => !a.pinned)).toHaveLength(CAPS.url)
  // 同じファイルの変更は行数を足し合わせる
  let files = addArtifacts([], [{ kind: 'file', value: '/p/a.ts', change: { isNew: true, added: 10, removed: 0 } }], 1)
  files = addArtifacts(files, [{ kind: 'file', value: '/p/a.ts', change: { isNew: false, added: 2, removed: 1 } }], 2)
  expect(files).toHaveLength(1)
  expect(files[0]!.change).toEqual({ isNew: true, added: 12, removed: 1 })
  expect(lineCount('a\nb\n')).toBe(2)
})

test('上限は種類ごと：ファイルをたくさん触っても URL は押し出されない', () => {
  let list = addArtifacts([], [{ kind: 'url', value: 'https://dash.example.com' }], 1)
  list = addArtifacts(
    list,
    Array.from({ length: 45 }, (_, i) => ({ kind: 'file' as const, value: `/p/src/f${i}.ts` })),
    10,
  )
  expect(list.filter(a => a.kind === 'file')).toHaveLength(CAPS.file)
  expect(list.some(a => a.value === 'https://dash.example.com')).toBe(true)
})

test('ファイルはフォルダごとにまとめる（新しく触ったフォルダが先）', () => {
  const f = (path: string, at: number) => ({ id: `file:${path}`, kind: 'file' as const, value: path, at, pinned: false })
  const groups = groupByDir([f('/p/a/x.ts', 1), f('/p/b/y.ts', 5), f('/p/a/z.ts', 3), f('/p/top.md', 2)], '/p')
  expect(groups.map(g => g.dir)).toEqual(['b', 'a', '.'])
  expect(groups[1]!.items.map(i => i.value)).toEqual(['/p/a/x.ts', '/p/a/z.ts'])
})

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

test('成果物タブに、ファイルとサーバーの URL が並ぶ（ターミナル・デスクトップ両方）', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  // 成果物の保存先（プロジェクトごとの store）をメモリ上に用意する
  mock.store(on)
  on('fs.exists', () => ({ value: false }))
  on('tool.call', (_$, e) =>
    e.tool === 'Bash'
      ? { result: { stdout: '  ➜  Local:   http://localhost:5173/\n', stderr: '', interrupted: false } as never }
      : { result: {} as never },
  )
  await $.tool.call({ tool: 'Write', file_path: '/proj/docs/report.md', content: 'a\nb\nc\n' })
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: '開発用サーバーを起動' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cockpit', surface, ...PANE })
    expect(await ui.find({ type: 'Button', text: /ARTIFACTS 2/ })).toBeDefined()
    await ui.press({ key: 'tab-artifacts' })
    expect(await ui.find({ type: 'Text', text: /report\.md/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /新規 \+3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /localhost:5173/ })).toBeDefined()
    // ★で固定できる
    await ui.press({ key: 'pin:file:/proj/docs/report.md' })
    expect(await ui.find({ type: 'Button', key: 'pin:file:/proj/docs/report.md', text: '★' })).toBeDefined()
    await ui.press({ key: 'pin:file:/proj/docs/report.md' })
    await ui.press({ key: 'tab-tasks' })
    await ui.unmount()
  }
})

test('成果物は「今回」と「過去のセッションの分」に分け、過去の分は折りたたむ', async ($, on) => {
  on('clock.now', () => ({ value: 5_000 }))
  on('session.root', () => ({ value: '/proj' }))
  on('classic.SessionStart', () => ({}))
  // 前のセッションで見つけたものが保存されている状態
  mock.store(on, {
    'artifacts:/proj': [
      { id: 'url:https://old.example.com', kind: 'url', value: 'https://old.example.com', at: 1_000, pinned: false },
      { id: 'file:/proj/old.md', kind: 'file', value: '/proj/old.md', at: 1_000, pinned: false },
      { id: 'url:https://pinned.example.com', kind: 'url', value: 'https://pinned.example.com', at: 900, pinned: true },
    ],
  })
  on('fs.exists', () => ({ value: false }))
  on('tool.call', () => ({ result: {} as never }))
  // 新しい会話を始めたことにして、今回の作業でファイルを1つ作る
  await $.classic.SessionStart({ source: 'clear' } as never)
  await $.tool.call({ tool: 'Write', file_path: '/proj/new.md', content: 'a\n' })

  const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', ...PANE })
  // 見出しの件数は今回の分（★固定を含む）
  expect(await ui.find({ type: 'Button', text: /ARTIFACTS 2/ })).toBeDefined()
  await ui.press({ key: 'tab-artifacts' })
  expect(await ui.find({ type: 'Text', text: 'new.md' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /pinned\.example\.com/ })).toBeDefined()
  // 過去の分は折りたたまれていて、押すと出る
  expect(await ui.find({ type: 'Text', text: /old\.example\.com/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /過去のセッションの分 ·2/ })).toBeDefined()
  await ui.press({ key: 'toggle-past' })
  expect(await ui.find({ type: 'Text', text: /old\.example\.com/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'old.md' })).toBeDefined()
  await ui.unmount()
})
