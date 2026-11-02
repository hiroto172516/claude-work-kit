import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { chunk, createLedger, gist, inputStack, promptStarted, stepEnded, stepStarted, toolAnswered } from '../hooks/turns.ts'

const usage = (input: number, cacheRead: number, output: number) => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: 0,
  output_tokens: output,
})

test('集計：問い合わせごとに入力を「毎回送る分・過去の会話・今回の分」に分ける', () => {
  const l = createLedger()
  l.isFresh = true
  promptStarted(l, 't1', 'なぜログアウトされるの？')
  const t1 = stepStarted(l, 't1', 0, 'claude-opus-5-5', 200)
  chunk(t1, 0, 'thinking', 'たぶんトークンの更新が原因')
  chunk(t1, 1, 'tool_use', 'Read', 'Read')
  stepEnded(l, t1, usage(300, 14_000, 120), 'tool_use')
  expect(gist(t1)).toBe('1× Read')
  // 最初の問い合わせから「毎回送られる量」を測る
  expect(l.baseline).toBeGreaterThan(14_000)

  toolAnswered(l, 'Read', 8000, false)
  const t2 = stepStarted(l, 't1', 1, 'claude-opus-5-5', 200)
  chunk(t2, 0, 'text', 'タイマーが更新されていません')
  stepEnded(l, t2, usage(2300, 14_300, 40), 'end_turn')
  expect(gist(t2)).toBe('回答')
  const labels = inputStack(l, t2).map(b => b.label)
  expect(labels).toEqual(['指示・道具・メモリ', '過去の会話（1回分）', '道具の結果 · Read'])
  // 内訳の合計は、API が返した実際の入力の量と一致する
  expect(inputStack(l, t2).reduce((s, b) => s + b.tokens, 0)).toBe(16_600)
})

// cockpit の下で動く「エンジン」の代わり：考えて Read を使い、そのあと答える
function fakeEngine(on: On) {
  on('turn.step', async function* ($, e) {
    if (e.index === 0) {
      yield { kind: 'thinking' as const, index: 0, text: 'たぶんトークンの更新が原因' }
      yield { kind: 'tool' as const, index: 1, id: 'tu_1', name: 'Read' }
      yield { kind: 'input' as const, index: 1, json: '{"file_path":"src/auth.ts"}' }
      return {
        turnId: e.turnId,
        index: e.index,
        answer: '',
        toolUses: [{ name: 'Read', input: { file_path: 'src/auth.ts' } }],
        stopReason: 'tool_use' as const,
        usage: usage(300, 14_000, 120),
      }
    }
    yield { kind: 'text' as const, index: 0, text: 'タイマーが更新されていません。詳しくは https://docs.example.com/auth' }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'タイマーが更新されていません。詳しくは https://docs.example.com/auth',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: usage(2300, 14_300, 40),
    }
  })
  on('tool.call', async () => ({ result: 'x'.repeat(8000), text: 'x'.repeat(8000) }) as never)
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        window: 200_000,
        breakdown: {
          categories: [
            { name: 'System prompt', tokens: 3000, color: 'x', isDeferred: false, kind: 'used' },
            { name: 'System tools', tokens: 11_000, color: 'x', isDeferred: false, kind: 'used' },
            { name: 'Messages', tokens: 300, color: 'x', isDeferred: false, kind: 'used' },
          ],
        },
      },
      rateLimits: [],
    },
  }) as never)
  on('clock.now', () => ({ value: 1_000 }))
  mock.store(on)
}

async function step($: Engine, index: number) {
  const s = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', messageCount: 1 + index * 2 })
  for (;;) {
    const x = await s.next()
    if (x.done) return x.value
  }
}

const PANE = {
  component: 'Pane',
  requestId: 'cockpit',
  props: {
    title: 'cockpit',
    isFocused: true,
    bodyColumns: 46,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`TURNS タブに問い合わせごとの内訳が出て、押すと開閉できる（${surface}）`, async ($, on) => {
    fakeEngine(on)
    await $.turn.start({ text: 'なぜログアウトされるの？', turnId: 't1' })
    await step($, 0)
    await $.tool.call({ tool: 'Read', file_path: 'src/auth.ts' } as never)
    await step($, 1)
    await $.turn.complete({ answer: 'x', durationMs: 4200, isAborted: false, turnId: 't1', reason: 'answer' } as never)

    const ui = await $.ui.mount({ plugin: 'cockpit', surface, ...PANE })
    await ui.press({ key: 'tab-turns' })
    const nb = (s: string) => (surface === 'terminal' ? s : s.replace(/ /g, ' '))
    expect((await ui.find({ key: 'turn:1' }))?.text).toContain('#1 1× Read')
    expect((await ui.find({ key: 'turn:2' }))?.text).toContain('#2 回答')
    expect(await ui.find({ type: 'Text', text: /なぜログアウトされるの/ })).toBeDefined()
    // 最新の問い合わせは自動で開いている
    expect(await ui.find({ type: 'Text', text: /入力 16\.6k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /指示・道具・メモリ/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /道具の結果 · Read/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /返答の文章/ })).toBeDefined()
    // 1回目を開くと、あなたの指示・考えた量・道具の呼び出しが見える
    await ui.press({ key: 'turn:1' })
    expect(await ui.find({ type: 'Text', text: /あなたの指示/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /考えた量/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /道具の呼び出し · Read/ })).toBeDefined()
    // 自分で開閉したら、自動表示は止まる
    expect(await ui.find({ type: 'Button', key: 'turns-follow' })).toBeDefined()
    // 返答に出てきた URL は、成果物トレイにも入っている
    await ui.press({ key: 'tab-artifacts' })
    expect(await ui.find({ type: 'Text', text: /docs\.example\.com\/auth/ })).toBeDefined()
    await ui.unmount()
  })
}
