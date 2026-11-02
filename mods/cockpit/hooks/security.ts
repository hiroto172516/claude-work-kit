import type { SecCategory, SecEvent, SecLevel, SecLog } from '../types'

// セキュリティ監視の判定（画面に依存しない部分）。すべて手元のルールで判定し、AI は使わない。
// 目立たせるための「見える化」で、すべての危険を見抜ける保証はない。

export type Verdict = { level: SecLevel; category: SecCategory; target: string; host?: string }

export const CATEGORY_LABEL: Record<SecCategory, string> = {
  secret: '秘密情報',
  exfil: '外部へ送信',
  remote_exec: 'ネットから実行',
  privilege: '管理者権限',
  force_push: '強制 push',
  wipe: '一括削除',
  network: '外部通信',
  outside: '範囲外',
  delete: '削除',
  publish: '公開操作',
  install: 'インストール',
  config: '設定変更',
  safe: '通常',
}

// 秘密情報らしいファイル（見本用の .env.example などは除く）
const SECRET_PATH =
  /(^|[\/\s"'=])(\.env(\.[\w-]+)?|[\w.-]+\.(pem|key|p12|pfx|keystore)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.netrc|\.npmrc|\.pypirc|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|\.aws\/[\w/.-]*|\.ssh\/[\w/.-]*|\.kube\/config|\.docker\/config\.json|\.git-credentials)(?=$|[\s"';|&)])/i
const SECRET_EXCEPTION = /\.(example|sample|template|dist)(?=$|[\s"';|&)])|id_\w+\.pub/i

export function isSecretPath(path: string): boolean {
  return SECRET_PATH.test(path) && !SECRET_EXCEPTION.test(path)
}

// 表示・保存の前に、パスワードやトークンらしい文字列を伏せる
export function maskSecrets(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9._-]+)/g, '****')
    .replace(/((?:--?)(?:password|passwd|token|api[-_]?key|secret)[= ])\S+/gi, '$1****')
    .replace(/(Bearer\s+)\S+/gi, '$1****')
    .replace(/(\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY)\s*=\s*)("[^"]*"|'[^']*'|\S+)/g, '$1****')
    .replace(/([?&](?:token|access_token|api_key|apikey|key|secret|sig|signature|password)=)[^&#\s]+/gi, '$1****')
}

// 通信先のホスト名を取り出す
export function hostOf(text: string): string | undefined {
  const url = /https?:\/\/([^\/\s:"'?#]+)/i.exec(text)
  if (url) return url[1]!.toLowerCase()
  const ssh = /\b(?:ssh|scp|rsync|sftp)\b[^\n]*?(?:[\w.-]+@)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(text)
  return ssh ? ssh[1]!.toLowerCase() : undefined
}

// 作業フォルダの外か（一時フォルダと Claude Code 自身のフォルダは除く）
export function isOutside(path: string, root: string, home: string): boolean {
  if (!path.startsWith('/') && !path.startsWith('~')) return false
  const abs = normalize(path.startsWith('~') ? home + path.slice(1) : path)
  if (root && (abs === root || abs.startsWith(root + '/'))) return false
  if (/^\/(private\/)?(tmp|var\/folders)\//.test(abs)) return false
  if (home && abs.startsWith(home + '/.claude/') && !/\/settings(\.local)?\.json$/.test(abs)) return false
  return true
}

function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') out.pop()
    else if (part && part !== '.') out.push(part)
  }
  return '/' + out.join('/')
}

// Claude Code の設定ファイル
function isClaudeSettings(path: string): boolean {
  return /(^|\/)\.claude\/settings(\.local)?\.json$/.test(path)
}

const READ_TOOLS = new Set(['Read', 'NotebookRead', 'Glob', 'Grep'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])

// ツールの呼び出しを、危険度で分類する
export function classify(tool: string, input: Record<string, unknown>, root: string, home: string): Verdict {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')

  if (READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) {
    const path = str('file_path') || str('notebook_path') || str('path')
    const pattern = str('pattern') || str('glob')
    const isWrite = WRITE_TOOLS.has(tool)
    const target = path || pattern
    if (isSecretPath(path) || (tool === 'Glob' && isSecretPath(pattern))) {
      return { level: 'alert', category: 'secret', target }
    }
    if (isWrite && isClaudeSettings(path)) return { level: 'warn', category: 'config', target: path }
    if (path && isOutside(path, root, home)) return { level: 'warn', category: 'outside', target: path }
    return { level: 'ok', category: 'safe', target }
  }

  if (tool === 'WebFetch') {
    const url = str('url')
    return { level: 'warn', category: 'network', target: url, host: hostOf(url) }
  }

  if (tool === 'Bash') return classifyCommand(str('command'), root, home)

  return { level: 'ok', category: 'safe', target: tool }
}

// ヒアドキュメント（<<'EOF' … EOF）の中身は、ファイルに書く文章や Python などのプログラムなので
// シェルの命令としては判定しない。ただし bash・sh・zsh に渡したものはシェルの命令として実行されるので残す
export function stripHeredocs(command: string): string {
  return command.replace(
    /(\S+)?(\s*)<<-?\s*(['"]?)([A-Za-z_][\w-]*)\3([^\n]*)\n([\s\S]*?)\n\s*\4(?=\s|$|[;&|)])/g,
    (whole, before: string | undefined, gap: string, _q: string, tag: string, rest: string, body: string) =>
      /(^|\/)(ba|z|da)?sh$/.test(before ?? '') || /^\s*(-s\b|\|\s*(ba|z)?sh\b)/.test(rest)
        ? `${before ?? ''}${gap}<<${tag}${rest}\n${body}`
        : `${before ?? ''}${gap}<<${tag}${rest}`,
  )
}

// 引用符の中身（コミットメッセージや echo の文章など）を空にする。命令の形だけを残す
export function stripQuoted(command: string): string {
  return command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
}

// コミットメッセージ（-m "…"）を外す
function stripMessages(command: string): string {
  return command.replace(/(\s(?:-m|--message)\s*)("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g, '$1""')
}

// シェルのコマンドを分類する（いちばん危険度の高いものを採る）
// 命令の判定は「文章を取り除いた形」で、通信先や秘密情報のファイル名は「引用符は残した形」で行う
export function classifyCommand(command: string, root: string, home: string): Verdict {
  const raw = stripMessages(stripHeredocs(command))
  const c = stripQuoted(raw)
  const target = command.replace(/\s+/g, ' ').trim()
  const host = hostOf(raw)
  const alert = (category: SecCategory): Verdict => ({ level: 'alert', category, target, host })
  const warn = (category: SecCategory): Verdict => ({ level: 'warn', category, target, host })

  // ⛔ 警戒
  if (/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b|\b(ba|z)?sh\s+<\(\s*(curl|wget)|eval\s+"?\$\(\s*(curl|wget)/.test(c)) {
    return alert('remote_exec')
  }
  if (/\b(curl|wget|http)\b[^\n]*(\s-d\s*@|\s--data(-binary|-raw)?[ =]@|\s-F\s*\S+=@|\s--upload-file\s|\s-T\s)/.test(c)) {
    return alert('exfil')
  }
  if (/(^|[\s;&|(])sudo\s/.test(c)) return alert('privilege')
  if (/\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/.test(c)) return alert('force_push')
  if (/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*("?)(\/|~|\$HOME|\.\.)("?)(\/?\*?)(\s|$)/.test(c)) {
    return alert('wipe')
  }
  if (isSecretPath(raw)) return alert('secret')
  if (/\bchmod\s+(-R\s+)?777\b/.test(c)) return alert('privilege')

  // ⚠ 注意
  if (/\b(git\s+push|npm\s+publish|pnpm\s+publish|yarn\s+publish|gh\s+(pr\s+(create|merge)|release\s+create|repo\s+create)|vercel(\s+deploy)?\s+--prod)\b/.test(c)) {
    return warn('publish')
  }
  if (/(^|[\s;&|(])(curl|wget|ssh|scp|sftp|rsync|ftp|telnet|nc)\s/.test(c) && (host || /\b(ssh|scp|sftp|ftp|telnet)\b/.test(c))) {
    return warn('network')
  }
  if (/(^|[\s;&|(])(rm|rmdir|unlink|shred|trash)\s|\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s+\.|restore\s+\.|branch\s+-D|stash\s+(drop|clear))\b/.test(c)) {
    return warn('delete')
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b|\bpip3?\s+install\b|\buv\s+(pip\s+install|add)\b|\bbrew\s+(install|reinstall)\b|\bgem\s+install\b|\bcargo\s+install\b|\bgo\s+install\b|\bnpx\s/.test(c)) {
    return warn('install')
  }
  if (/\.claude\/settings(\.local)?\.json/.test(c) && /(>|\btee\b|\bsed\s+-i|\bmv\b|\bcp\b|python|jq)/.test(c)) return warn('config')
  // 作業フォルダの外への書き込み（リダイレクト先が外）
  for (const m of raw.matchAll(/(?:^|[^>&\d])>>?\s*(["']?)([~\/][^\s"';|&)]+)\1/g)) {
    const to = m[2]!
    if (/^\/dev\//.test(to)) continue
    if (isOutside(to, root, home)) return warn('outside')
  }

  return { level: 'ok', category: 'safe', target, host }
}

// ---- 記録 ----

export const KEEP_EVENTS = 300
export const KEEP_DAYS = 7

export function dayKey(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const EMPTY_LOG: SecLog = { days: {}, events: [], rulesVersion: 2 }

// 1件記録する：日ごとの件数を数え、⛔・⚠ は中身も残す。7日より古いものは捨てる
export function record(log: SecLog, event: SecEvent): SecLog {
  const day = dayKey(event.at)
  const counts = log.days[day] ?? { ok: 0, warn: 0, alert: 0 }
  const days = { ...log.days, [day]: { ...counts, [event.level]: counts[event.level] + 1 } }
  const cutoff = event.at - KEEP_DAYS * 24 * 60 * 60 * 1000
  const keepDays = Object.fromEntries(Object.entries(days).filter(([d]) => d >= dayKey(cutoff)))
  const events =
    event.level === 'ok'
      ? log.events
      : [event, ...log.events].filter(e => e.at >= cutoff).slice(0, KEEP_EVENTS)
  return { days: keepDays, events, rulesVersion: log.rulesVersion }
}

// 直近3時間を10分ごとに区切り、区間ごとの最大の危険度と件数を返す
export function timeline(events: readonly SecEvent[], now: number, buckets = 18, size = 10 * 60 * 1000) {
  const start = now - buckets * size
  const out = Array.from({ length: buckets }, () => ({ count: 0, level: 'ok' as SecLevel }))
  for (const e of events) {
    if (e.at < start || e.at > now) continue
    const i = Math.min(buckets - 1, Math.floor((e.at - start) / size))
    const b = out[i]!
    b.count += 1
    if (e.level === 'alert' || (e.level === 'warn' && b.level === 'ok')) b.level = e.level
  }
  return out
}

// ---- 判定ルールを直したときの、保存済みの記録の判定し直し ----

// 判定ルールの版。ルールを直したら上げる
export const RULES_VERSION = 2

// 保存済みの ⛔・⚠ を新しいルールで判定し直す。「通常」になったものは記録から外し、日ごとの件数も付け替える。
// 記録にはプロジェクトの場所が残っていないので、「範囲外」は出力先が /dev などに変わったものだけ外す
export function migrateLog(log: SecLog, home: string): SecLog {
  if ((log.rulesVersion ?? 1) >= RULES_VERSION) return log
  const days = Object.fromEntries(Object.entries(log.days).map(([d, c]) => [d, { ...c }]))
  const events: SecEvent[] = []
  for (const ev of log.events) {
    let next: SecEvent | null = ev
    if (ev.tool === 'Bash') {
      const loose = classifyCommand(ev.target, '/', home)
      if (ev.category === 'outside') {
        const strict = classifyCommand(ev.target, '', home)
        next = strict.category === 'outside' ? ev : loose.level === 'ok' ? null : { ...ev, level: loose.level, category: loose.category }
      } else {
        next = loose.level === 'ok' ? null : { ...ev, level: loose.level, category: loose.category }
      }
    }
    const day = days[dayKey(ev.at)]
    if (day && (next === null || next.level !== ev.level)) {
      day[ev.level] = Math.max(0, day[ev.level] - 1)
      day[next === null ? 'ok' : next.level] += 1
    }
    if (next) events.push(next)
  }
  return { days, events, rulesVersion: RULES_VERSION }
}
