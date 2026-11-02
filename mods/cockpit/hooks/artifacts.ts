import type { Artifact, ArtifactKind } from '../types'

// 成果物トレイの計算（画面に依存しない部分）。拾い方はすべて決まったルールで、AI は使わない

// プロジェクトごとに残す件数。種類ごとに分け、ファイルが多くても URL が押し出されないようにする
// （★固定したものは別枠で残す）
export const CAPS: Record<ArtifactKind, number> = { url: 20, file: 20, command: 10, ref: 10 }

// URL の終わりに付きがちな記号は外す
const URL_RE = /https?:\/\/[^\s<>"'`)\]}、。」』）]+/g
const TRAILING = /[.,;:!?*_~]+$/

// トークンや鍵らしいクエリの値は伏せる
const SECRET_PARAM = /([?&](?:token|access_token|api_key|apikey|key|secret|sig|signature|password|pwd|auth)=)[^&#]+/gi

export function maskUrl(url: string): string {
  return url.replace(SECRET_PARAM, '$1****')
}

export function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(url)
}

// 文章から URL を拾う（重複は除く）
export function extractUrls(text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(URL_RE)) {
    const url = maskUrl(m[0].replace(TRAILING, ''))
    if (url.length > 'https://'.length + 2) found.add(url)
  }
  return [...found]
}

// コマンド出力から拾うのは、手元のサーバーと GitHub のプルリクエストだけ（雑音を避ける）
export function extractToolUrls(text: string): string[] {
  return extractUrls(text).filter(u => isLocalUrl(u) || /github\.com\/[^/]+\/[^/]+\/(pull|compare)\//.test(u))
}

const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'terminal'])

// 返答の中で、シェル用のコードとして示されたコマンドを拾う
export function extractCommands(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/```([A-Za-z]*)[^\n]*\n([\s\S]*?)```/g)) {
    if (!SHELL_LANGS.has((m[1] ?? '').toLowerCase())) continue
    const lines = (m[2] ?? '')
      .split('\n')
      .map(l => l.replace(/^\s*[$%>]\s+/, '').trimEnd())
      .filter(l => l.trim() && !l.trim().startsWith('#'))
    // 長すぎるもの（スクリプト丸ごとなど）は成果物として扱わない
    if (lines.length === 0 || lines.length > 4) continue
    const cmd = lines.join('\n')
    if (cmd.length <= 300 && !out.includes(cmd)) out.push(cmd)
  }
  return out
}

// URL の種類：手元のサーバー／GitHub／その他
export function urlGroup(url: string): 'local' | 'github' | 'web' {
  if (isLocalUrl(url)) return 'local'
  if (/^https?:\/\/(www\.)?github\.com\//i.test(url)) return 'github'
  return 'web'
}

// ファイルの変更行数（だいたい）：Write は新しい中身の行数、Edit は置き換えた前後の行数
export function lineCount(text: string): number {
  if (!text) return 0
  return text.replace(/\n$/, '').split('\n').length
}

export type NewArtifact = Omit<Artifact, 'id' | 'at' | 'pinned'>

// 追加：同じものは新しい時刻に上げて情報をまとめる。古いものから捨てるが、★固定は残す
export function addArtifacts(list: readonly Artifact[], items: readonly NewArtifact[], now: number): Artifact[] {
  let next = [...list]
  items.forEach((item, i) => {
    const id = `${item.kind}:${item.value}`
    const prev = next.find(a => a.id === id)
    const merged: Artifact = prev
      ? {
          ...prev,
          at: now + i,
          change:
            prev.change && item.change
              ? {
                  isNew: prev.change.isNew,
                  added: prev.change.added + item.change.added,
                  removed: prev.change.removed + item.change.removed,
                }
              : (item.change ?? prev.change),
        }
      : { ...item, id, at: now + i, pinned: false }
    next = [merged, ...next.filter(a => a.id !== id)]
  })
  const pinned = next.filter(a => a.pinned)
  const kinds = Object.keys(CAPS) as ArtifactKind[]
  const rest = kinds.flatMap(kind => next.filter(a => !a.pinned && a.kind === kind).slice(0, CAPS[kind]))
  return [...pinned, ...rest].sort((a, b) => b.at - a.at)
}

export function togglePin(list: readonly Artifact[], id: string): Artifact[] {
  return list.map(a => (a.id === id ? { ...a, pinned: !a.pinned } : a))
}

export function removeArtifact(list: readonly Artifact[], id: string): Artifact[] {
  return list.filter(a => a.id !== id)
}

// 表示用：種類ごとに、★固定を先頭・あとは新しい順
export function grouped(list: readonly Artifact[], kind: ArtifactKind): Artifact[] {
  return list.filter(a => a.kind === kind).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at - a.at)
}

// 長いパスは後ろを残して短くする
export function shortPath(path: string, root: string, max: number): string {
  let p = path.startsWith(root + '/') ? path.slice(root.length + 1) : path.replace(/^\/Users\/[^/]+/, '~')
  if (p.length > max) p = '…' + p.slice(p.length - max + 1)
  return p
}

// URL を短く見せる（https:// を外し、長ければ後ろを省略）
export function shortUrl(url: string, max: number): string {
  const u = url.replace(/^https?:\/\//, '')
  return u.length > max ? u.slice(0, max - 1) + '…' : u
}

// ファイルをフォルダごとにまとめる（新しく触ったフォルダが先）
export function groupByDir(files: readonly Artifact[], root: string): { dir: string; items: Artifact[] }[] {
  const groups = new Map<string, Artifact[]>()
  for (const f of files) {
    const rel = shortPath(f.value, root, 10_000)
    const cut = rel.lastIndexOf('/')
    const dir = cut === -1 ? '.' : rel.slice(0, cut)
    groups.set(dir, [...(groups.get(dir) ?? []), f])
  }
  return [...groups.entries()]
    .map(([dir, items]) => ({ dir, items }))
    .sort((a, b) => Math.max(...b.items.map(i => i.at)) - Math.max(...a.items.map(i => i.at)))
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
