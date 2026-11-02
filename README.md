# 会社PC用 Claude Code セット（CLAUDE.md と mod）

## 中身

| ファイル | 入る場所 | 内容 |
|---|---|---|
| `CLAUDE.md` | `~/.claude/CLAUDE.md` | 全プロジェクト共通の指示（会社向けに書き直したもの） |
| `mods/status-band` | `~/mods/status-band` | 入力欄の上に、モデル・場所・コンテキスト・使用制限を3行で表示する |
| `mods/cockpit` | `~/mods/cockpit` | 右のパネルに、タスク・成果物・セキュリティの状況を表示する |
| `install.sh` | — | 上の3つを置いて、`settings.json` に mod の場所を登録する |

## 入れ方

1. 会社PCに Claude Code を入れて、**会社のアカウントで**ログインしておく
2. このフォルダを会社PCに移す（会社が認めている方法で）
3. このフォルダで `bash install.sh` を実行する
4. Claude Code を起動し直し、入力欄の上の帯と右のパネルが出ることを確かめる

既にあるファイルは `.bak-日時` を付けて退避してから置き換えます。`settings.json` は mod の場所を足すだけで、ほかの設定には触りません。

## 入れたあとにやること

- `CLAUDE.md` の「秘密情報の管理」にある `TODO` に、会社のパスワード管理ツールの名前と「AIが使ってよい保管場所」を書く
- 会社で CodeGraph を使わないなら、`CLAUDE.md` の CodeGraph の節を消してもよい（使えないときは無視するように書いてあります）
- cockpit の `hooks/turns.ts` は MIT ライセンスのコードを元にしています（`THIRD_PARTY_NOTICES.md`）。会社で外部のコードの扱いに決まりがあれば確認する

## 元のPCの CLAUDE.md から変えたところ

- 1Password の `AI-Agents` / `Personal` Vault の話を外し、どの管理ツールでも使える書き方に変えた（会社のツール名は TODO）
- 「会社やチームの決まりを優先する」「会社の情報を外部へ送らない」を足した
- Python は、プロジェクトに決まった方法（uv など）があればそれを使うようにした
- 下調べのときは、まず社内に同じような実装がないかを見て、検索の言葉に会社の固有の名前を入れないようにした
- CodeGraph の節は「使える場合だけ従う」に変えた

## 補足

- 各 mod の `.claude-plugin/types/`（型定義）は、Claude Code が mod を読み込むときに自動で作ります。このリポジトリには入れていません。
