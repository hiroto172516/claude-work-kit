import { expect, test } from 'claude-code/testing'

import {
  barCells,
  cacheHitPct,
  cacheStateOf,
  cacheTtlMs,
  formatElapsed,
  formatRemaining,
  formatTime,
  formatTokens,
  levelColor,
  outlook,
  padLabel,
  prettyModel,
  prettyPath,
  verdictOf,
} from '../hooks/register.tsx'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('小さな部品が正しく整形する', () => {
  expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5')
  expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(formatTokens(84_200)).toBe('84k')
  expect(formatTokens(3_400)).toBe('3.4k')
  expect(formatTokens(1_000_000)).toBe('1M')
  expect(barCells(42, 10)).toEqual({ filled: 4, ahead: 0, empty: 6 })
  expect(barCells(30, 10, 70)).toEqual({ filled: 3, ahead: 4, empty: 3 })
  expect(barCells(60, 10, 150)).toEqual({ filled: 6, ahead: 4, empty: 0 })
  expect(levelColor(10)).not.toBe(levelColor(90))
  expect(padLabel('5時間')).toBe('5時間       ')
  expect(padLabel('コンテキスト')).toBe('コンテキスト')
  expect(prettyPath('/Users/someone/Project/openspace', 40)).toBe('~/Project/openspace')
  expect(formatTime(new Date(2026, 9, 9, 10, 0), 'seven_day')).toBe('10/9(金) 10時')
  expect(formatTime(new Date(2026, 9, 5, 6, 5), 'five_hour')).toBe('06:05')
  expect(formatRemaining(13 * 60_000)).toBe('あと13分')
  expect(formatRemaining(133 * 60_000)).toBe('あと2時間13分')
  expect(formatRemaining((3 * 24 + 22) * 60 * 60_000)).toBe('あと3日22時間')
  expect(formatElapsed(84_000)).toBe('1:24')
  expect(formatElapsed(3_725_000)).toBe('1:02:05')
})

test('上限の見通し', () => {
  const H = 60 * 60 * 1000
  const resetsAt = new Date(5 * H).toISOString()
  // 枠の開始（0時）から2時間で80%：リセット時200%の見込み、2.5時間で到達
  const over = { kind: 'five_hour', percentUsed: 80, resetsAt }
  const o1 = outlook(over, 2 * H)!
  expect(o1.atReset).toBe(200)
  expect(o1.fullAt).toBe(2.5 * H)
  expect(verdictOf(over, o1)).toBe('over')
  // 2時間で20%：リセット時50%＝余力あり
  const ok = { kind: 'five_hour', percentUsed: 20, resetsAt }
  const o2 = outlook(ok, 2 * H)!
  expect(o2.fullAt).toBeNull()
  expect(verdictOf(ok, o2)).toBe('ok')
  // 4時間で70%：リセット時87.5%＝上限接近
  const tight = { kind: 'five_hour', percentUsed: 70, resetsAt }
  expect(verdictOf(tight, outlook(tight, 4 * H)!)).toBe('tight')
  // 使い切り
  const hit = { kind: 'five_hour', percentUsed: 100, resetsAt }
  expect(verdictOf(hit, outlook(hit, 3 * H)!)).toBe('hit')
  // 始まったばかりは判断しない
  expect(outlook({ kind: 'five_hour', percentUsed: 5, resetsAt }, 5 * 60 * 1000)).toBeUndefined()
})

test('キャッシュの状態', () => {
  const M = 60 * 1000
  const sub = [{ kind: 'five_hour', percentUsed: 10 }]
  expect(cacheTtlMs(sub)).toBe(60 * M)
  expect(cacheTtlMs([])).toBe(5 * M)
  const warm = { at: 0, read: 96_000, write: 3_000, fresh: 1_000 }
  expect(cacheHitPct(warm)).toBe(96)
  // 1時間の有効期間：残り52分は有効、残り4分は期限切れ間近、61分後は期限切れ
  expect(cacheStateOf(warm, 60 * M, 8 * M)).toBe('warm')
  expect(cacheStateOf(warm, 60 * M, 56 * M)).toBe('expiring')
  expect(cacheStateOf(warm, 60 * M, 61 * M)).toBe('expired')
  // 5分の有効期間：残り30秒は期限切れ間近
  expect(cacheStateOf(warm, 5 * M, 4.5 * M)).toBe('expiring')
  // 大きな会話でほとんど再利用できなかった＝外れ
  expect(cacheStateOf({ at: 0, read: 0, write: 80_000, fresh: 500 }, 60 * M, M)).toBe('missed')
  // 小さな会話では外れ扱いにしない
  expect(cacheStateOf({ at: 0, read: 0, write: 5_000, fresh: 500 }, 60 * M, M)).toBe('warm')
})

test('帯に内容が出る（ターミナル・デスクトップ両方）', async ($, on) => {
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 84_000, window: 200_000, percent: 42 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 18, resetsAt: '2026-10-05T06:00:00Z' },
        { kind: 'seven_day', percentUsed: 63, resetsAt: '2026-10-09T01:00:00Z' },
      ],
      cost: { usd: 1.234 },
    },
  }))
  on('clock.now', () => ({ value: Date.parse('2026-10-05T03:00:00Z') }))
  // 帯の下に何もない状態（エンジン側の描画なし）を再現する
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return Box({ key: 'engine-empty' })
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'status-band', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: '42%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '84k / 200k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '≈ $1.23' })).toBeDefined()
    // 5時間枠：開始から2時間で18%＝リセット時約45%→余力あり
    expect(await ui.find({ type: 'Text', text: /余力あり/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'リセット時 約45%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /あと3時間）/ })).toBeDefined()
    // 週間枠：開始から約3日で63%＝リセット前に上限の見込み
    expect(await ui.find({ type: 'Text', text: /上限見込み/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /頃に到達/ })).toBeDefined()
    // まだ問い合わせがないので、キャッシュは表示しない
    expect(await ui.find({ type: 'Text', text: /キャッシュ/ })).toBeUndefined()
    await ui.unmount()
  }
})
