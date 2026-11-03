# レビュー依頼（トリプルチェック）

PUG 練習出欠アプリのセキュリティと設計を、Web に詳しい方の目で確認していただくためのガイドです。
自動チェック（GitHub Actions）と運営による目視チェックはすでに通っています。今回は **3 人目の独立したレビュー** をお願いしたいです。

- まず読むもの：[仕組みの全体像（ARCHITECTURE.md）](ARCHITECTURE.md)。構成図・データフロー・権限・対策の一覧があります
- 対象コード：[`index.html`](../index.html)（画面）、[`gas/Code.gs`](../gas/Code.gs)（API）、[`scripts/review-gate.js`](../scripts/review-gate.js)、[`.github/workflows/review-gate.yml`](../.github/workflows/review-gate.yml)
- 規模：画面 約 600 行、API 約 570 行（どちらもライブラリなし・1 ファイル）
- 所要時間の目安：30〜60 分

## 1. 手元で動かす（任意・5 分）

```bash
git clone https://github.com/Kkenjis/pug-tennis.git
cd pug-tennis
node scripts/review-gate.js security   # 自動セキュリティチェック（Node 18 以上）
```

画面はデモモードで、ログインなしに 3 つの役割で動かせます。データはブラウザの中だけで、本番には一切接続しません。

- `index.html` をブラウザで直接開く → 管理者のデモ
- 公開版で見る場合：`https://kkenjis.github.io/pug-tennis/?demo`（管理者）、`?demo=member`（メンバー）、`?demo=guest`（ゲスト）

本番の API やスプレッドシートへの攻撃的なテストは控えてください。確認したいことがあれば運営が代わりに実施します。

## 2. 特に見てほしい観点

運営として自信がない、または見落としが怖いところです。上から優先度順です。

### 認証・認可（`gas/Code.gs`）

- [ ] `verifyIdToken_`：LINE の検証 API の使い方（`client_id` 指定、`aud` 確認、`exp` とキャッシュ時間）に抜けはないか
- [ ] `handle_`：管理者操作（`createEvents` / `deleteEvent` / `setGuestOpen`）の前に必ず `requireAdmin()` が通るか。抜け道になる `action` はないか
- [ ] ゲスト制限：`listEvents_`（見える日）と `saveEntry_`（回答できる日）の両方で効いているか
- [ ] 他人の回答を書き換え・削除できる経路はないか（`saveEntry_` は検証済み `userId` だけを使う想定）

### 画面（`index.html`）

- [ ] XSS：利用者由来の文字（表示名・コメント・場所・メモ）がすべて `esc()` を通っているか。`innerHTML` に生で入る箇所はないか
- [ ] ID トークンの扱い：`CONFIG.GAS_URL` 以外に送られていないか、ログや URL に出ていないか
- [ ] 再ログインの制御（`relogin()`）に無限ループや想定外の遷移はないか
- [ ] デモモードの判定（`?demo`・`file://`）が本番の動作に影響しないか
- [ ] 即時反映（`CONFIG.FAST_TAP` / `saveEntryFast` / `saveGuestOpenFast` / `queueSave`）：連打しても保存の順番が入れ替わらないか、失敗時に正しい状態へ戻るか

### サーバーの堅牢性（`gas/Code.gs`）

- [ ] 数式インジェクション対策（`safeCell_`）の漏れ：シートへ書き込むすべての利用者由来の値に効いているか
- [ ] 入力上限（`LIMITS`）と、不正な型（配列・オブジェクト・巨大な文字列）への耐性
- [ ] 大量アクセス時の挙動（検証 API の回数上限、Apps Script の同時実行数、`LockService` のタイムアウト）
- [ ] エラー応答や操作ログから、内部情報や個人情報（userId など）が漏れていないか

### 運用・CI

- [ ] `review-gate.yml`：`pull_request` トリガーと権限（`contents: read`）は安全か。フォークからの PR で悪用できないか
- [ ] `review-gate.js` の検査は「すり抜け」られないか（例：別名で `fetch` を呼ぶ、`esc` を経由したように見せかける）
- [ ] [ARCHITECTURE.md の「11. 既知の制約」](ARCHITECTURE.md#11-既知の制約と今後の検討)の判断（CSP 見送りなど）は妥当か

## 3. 範囲外

- LINE / Google / GitHub といったプラットフォーム自体の安全性
- 見た目やデザインの好み（気づいた点があれば歓迎です）
- 参加費の支払い管理（このアプリは金額の表示だけで、支払いは扱いません）

## 4. 結果の伝え方

どれでも構いません。

- **Issue**：「Issue を作成」→ テンプレート「レビュー指摘」を選ぶ（1 件 1 Issue だと対応を追いやすいです）
- **まとめて 1 つの Issue / メッセージ**：観点ごとに「問題なし／指摘あり」を書いてもらえれば十分です

重要度の目安：

| 重要度 | 目安 |
| --- | --- |
| 高 | すぐに悪用でき、なりすまし・データの改ざん・情報漏えいにつながる |
| 中 | 条件がそろうと実害につながりうる |
| 低 | 起きにくい、または影響が小さい |
| 提案 | 安全性に問題はないが、こうした方がよい |

修正は「プルリクエスト → 自動チェック → 目視チェック → マージ」の順で行い、本番に出す前に必ず人が確認します（[README の更新のルール](../README.md#更新のルールリリースのgoサイン)）。

ご協力ありがとうございます！
