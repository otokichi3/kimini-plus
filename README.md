# Kimini → Google カレンダー

Kimini英会話でレッスンを予約すると、Googleカレンダーに自動で予定を登録するChrome拡張機能。

## しくみ

Kimini は SPA ではなく通常のページ遷移で動いており、予約は `reserve_f` フォームが
`/plus/lesson/reserve/result` に POST する形で確定する。kimini.online 自身の XHR は無いため、
API のレスポンスを傍受する方法は使えない。そこで DOM から読み取る方式を取っている。

- **予約確定の直後**（`/plus/lesson/reserve/result`）に着地したら、その場で読み取って登録する
- **取りこぼしの保険**として、学習カレンダーやレッスン一覧を開いたときにも未登録の予約を拾う

レッスン詳細リンク `/plus/lesson/<id>` の id を一意キーとし、カレンダー側の `iCalUID` に使う。
同じ予約を何度読み取っても、登録されるのは1件だけになる。

過去のレッスンを拾わないよう、開始時刻が未来のものだけを対象にしている
（Kimini では受講済みレッスンにラベルが付かないため、ラベルだけでは判別できない）。

## セットアップ

### 1. 拡張機能を読み込む

1. Chrome で `chrome://extensions` を開く
2. 右上の「デベロッパーモード」をオンにする
3. 「パッケージ化されていない拡張機能を読み込む」でこのフォルダを選ぶ
4. 拡張機能の ID が `nngimhenmgcebojjiolkmpgehgpndnpf` になっていることを確認する

ID は `manifest.json` の `key` で固定してある。この ID を次の手順で使う。
`key.pem` は ID を再現するための秘密鍵なので、公開リポジトリには入れないこと。

### 2. Google Cloud 側の設定（設定済み）

Google Cloud プロジェクト **otokichi-app** に以下を設定済み。作り直す場合の記録として残す。

- **Google Calendar API** を有効化
- OAuth 同意画面: 既存のものを使用（外部・本番環境。テストユーザー登録は不要）
- データアクセスに `https://www.googleapis.com/auth/calendar.events` を追加
- OAuth クライアント（種類: Chrome 拡張機能、名前: Kimini to Google Calendar）を作成
  - アイテム ID: `nngimhenmgcebojjiolkmpgehgpndnpf`
  - クライアント ID は `manifest.json` の `oauth2.client_id` に設定済み

`calendar.events` は Google が「機密性の高いスコープ」に分類しているため、
アプリ検証を受けていない状態では認可時に「このアプリは Google で確認されていません」と表示される。
自分のアカウントで使う分には「詳細」→「安全でないページに移動」で進めればよい。
個人利用（100ユーザーまで）なら検証申請は不要。

### 3. アカウントを連携する

拡張機能の「詳細」→「拡張機能のオプション」から設定ページを開き、
「Googleアカウントを連携」を押して認可する。

## 設定項目

| 項目 | 既定値 | 説明 |
| --- | --- | --- |
| 自動登録 | オン | オフにすると何もしない |
| カレンダーID | `primary` | 別のカレンダーに入れたい場合に指定 |
| タイトル | `Kimini英会話 - {teacher}` | `{teacher}` `{course}` `{material}` が使える |
| 通知 | 10分前 | `-1` で通知なし |

## 構成

```
manifest.json      拡張機能の定義。client_id はここに書く
src/content.js     Kimini のページから予約を読み取る
src/background.js  Google カレンダーに登録する
src/options.html   設定ページ
src/options.js
key.pem            拡張機能 ID を固定するための秘密鍵（コミットしない）
```
