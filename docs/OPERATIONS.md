# 運用ランブック

このドキュメントは、デプロイした Muse Auth Bridge を運用するための手順書です。
設計の考え方は `README.md` と `DESIGN.md` にあります。ここには「何かあったときに、どの順番で何をするか」だけを書きます。

## 1. デプロイ

前提: Cloudflare アカウントと、Worker に入れるシークレット一式。

```bash
npx wrangler login

# 橋のトークン（役割ごとに1つ、長いランダム値。例: openssl rand -hex 32）
npx wrangler secret put BRIDGE_TOKEN_READ
npx wrangler secret put BRIDGE_TOKEN_WRITE
npx wrangler secret put BRIDGE_TOKEN_ADMIN

# 使うアダプタの分だけ
npx wrangler secret put SWITCHBOT_TOKEN
npx wrangler secret put SWITCHBOT_SECRET
npx wrangler secret put QINGPING_APP_KEY
npx wrangler secret put QINGPING_APP_SECRET

# 推奨: ブレイカー状態を永続化する KV
npx wrangler kv namespace create BRIDGE_KV   # 出力された id を wrangler.toml に書く

npx wrangler deploy
```

デプロイ直後に必ず疎通テストを走らせる（次節）。

## 2. 疎通テスト（スモークテスト）

```bash
BRIDGE_URL=https://muse-auth-bridge.<あなたのサブドメイン>.workers.dev \
BRIDGE_TOKEN_READ=... BRIDGE_TOKEN_WRITE=... BRIDGE_TOKEN_ADMIN=... \
node scripts/smoke-test.mjs
```

確認する内容:

1. `/health` が 200 で返る
2. トークンなしのリクエストが 401 で拒否される
3. read トークンで読み取りルートが通る（アダプタ未設定なら 501、それも疎通の証拠）
4. read トークンでは書き込みルートが使えない（403）
5. **ブレイカー訓練**: admin でブレイカーを入れる → 全ルートと `/health` が 503 になる → admin で解除できる（解除ルートはブレイカー中も届く設計）→ `/health` が 200 に戻る

ブレイカー訓練を省く場合は `--no-breaker` を付ける。訓練は一瞬だけ全停止するので、本番で走らせるなら利用していない時間帯に。

ローカルでも同じスクリプトが使える（`npm run dev` で起動し、`BRIDGE_URL=http://localhost:8787`、トークンは `.dev.vars` の値）。

## 3. 漏洩を疑ったときの手順（ブレイカー）

合言葉は「**止めてから、調べる**」。細かい失効手続きを漏洩の最中に思い出す必要はない。関所は1か所しかない。

### 手順

1. **ブレイカーを入れる**（全サービスが即座に止まる）

   ```bash
   curl -X POST -H "Authorization: Bearer <ADMINトークン>" \
     https://muse-auth-bridge.<サブドメイン>.workers.dev/admin/breaker/on
   ```

   **応答の `durable: true` を必ず確認する。** `durable: false` の場合は KV への保存に失敗していて、止まっているのはリクエストを受けた isolate だけ（他の isolate では通る）。その場合は確実な停止手段である `BRIDGE_DISABLED`（下記）に切り替える。

   Cloudflare の画面から止める方法もある: Workers の設定で変数 `BRIDGE_DISABLED` を `true` にして再デプロイする。admin トークン自体が漏れた可能性がある場合はこちらを使う（ブレイカーの解除にも admin が要るため）。**注意: 画面で変えただけだと、次の通常デプロイで上書きされてブレイカーが外れる。** wrangler 運用なら `wrangler.toml` の [vars] も `true` に書き換え、API経由デプロイなら投入するバインディング側も合わせて変更すること。

2. **橋のトークンを全部入れ替える**

   ```bash
   npx wrangler secret put BRIDGE_TOKEN_READ    # 新しい値
   npx wrangler secret put BRIDGE_TOKEN_WRITE
   npx wrangler secret put BRIDGE_TOKEN_ADMIN
   ```

   コネクタ側の登録値も新しい read トークンに更新する。重なり期間が要る場合は、カンマ区切りで旧・新を併記してから旧を消す。

3. **漏れた範囲に応じて、ベンダー側の秘密も入れ替える**
   - 橋のトークンだけが漏れた疑い: 手順2までで足りる。ベンダーの秘密は Worker の外に出ていない。
   - Worker のシークレット自体が漏れた疑い: ベンダー側で再発行する（SwitchBot はアプリの開発者オプションでトークン再発行、Qingping は開発者コンソールで App Secret 再発行）→ `wrangler secret put` で入れ替える。

4. **ブレイカーを解除する**

   ```bash
   curl -X POST -H "Authorization: Bearer <新しいADMINトークン>" \
     https://muse-auth-bridge.<サブドメイン>.workers.dev/admin/breaker/off
   ```

5. **スモークテストで復旧を確認する**（第2節）。

### 効き方の確認済み事項

- ブレイカーは認証より前に効く。正規のトークンでも 503 になる。
- 例外は `/admin/breaker/*` のみ（admin トークン必須）。解除できないブレイカーは罠になるため、この例外は意図的な設計。
- KV を付けていない場合、ブレイカー状態は isolate 内にしか残らない。再配置で消えることがあるので、本番では KV を付けるか、`BRIDGE_DISABLED` 変数と併用する。
- KV は結果整合性のため、ブレイカーの切り替えが全エッジに伝わるまで最大で60秒ほどかかることがある（実測でも確認済み）。「今この瞬間に、確実に全部止める」必要があるときは、KV のブレイカーではなく `BRIDGE_DISABLED=true` ＋再デプロイを使う。スモークテストのブレイカー訓練は、この伝播待ちをポーリングで吸収するようになっている。
- KV が障害を起こしている間、キャッシュを持たない新しい isolate ではブレイカー状態を読み取れず、**OFF 側に倒れる（止めたつもりで開く経路がある）**。可用性を優先した意図的な選択だが、「確実に止まっていること」自体が要件のときは、KV のブレイカーではなく `BRIDGE_DISABLED` を使うこと。

## 4. 日常のローテーション

- 橋のトークン: 漏洩時が本番。定期ローテーションは必須ではない（個人運用で回らない仕組みは置かない、という設計判断）。
- ベンダーの秘密: ベンダー側の都合（再発行したら旧値が死ぬ等）に従う。
- 変更したら必ずスモークテストを走らせる。

## 5. 困ったときの見分け方

| 症状 | まず見る場所 |
|---|---|
| 全部 503 | ブレイカーが入っていないか（`/health` の `breakerOn`、`/admin/status`） |
| 全部 401 | コネクタに登録したトークンと Worker のシークレットの不一致（401は常に橋側のトークンの問題。ベンダー側の拒否は502で返る） |
| 502 `vendor_auth_error` | ベンダー側が橋の資格情報を拒否した（ベンダーのトークン無効、日次上限超過など）。本文の `vendorStatus` と `vendorBody` を確認 |
| 502 `vendor_rate_limited` | ベンダー側のレート制限（ベンダーの429）。橋自身のレート制限（429 `rate_limited`）とは別物 |
| 502 `vendor_error` | ベンダーが本文でエラーを返した（SwitchBot の statusCode 161 = デバイスオフライン等） |
| 読み取りは通るが書き込みが 403 | read トークンで書き込みルートを叩いている（役割の分離どおり） |
| 特定アダプタだけ 501 | そのベンダーのシークレットが Worker に未設定 |
| 特定アダプタだけ 502（Qingping） | トークン取得の失敗。App Key / Secret の再発行有無を確認 |
| 429 | レート制限。`RATE_LIMIT_PER_MINUTE` の値と、想定外の呼び出し元を確認 |

## 6. 既知のトレードオフ

- **Qingping のアクセストークンは KV に平文でキャッシュされる**（有効期限は約2時間）。App Key / Secret 自体は Worker のシークレットとして暗号化保管されるが、派生したトークンは、ダッシュボードや KV 読み取り権限のある API トークンからは読める。影響範囲は「そのベンダーの、その2時間」に限られる、という割り切りで置いている。気になる場合は KV バインディングを外すと isolate 内メモリだけになり、代わりにトークン取得の回数が増える。
- **書き込みは許可リスト制**（v0.2〜）。`SWITCHBOT_ALLOWED_COMMANDS`（デバイスID:コマンドの組）と `SWITCHBOT_ALLOWED_SCENES`（シーンID）が未設定の間は、write トークンでも一切の操作が 403 で拒否される。デバイスを操作したくなったら、対象を明示して vars に足すこと。特にロック系デバイスの unlock は、入れる前に「このトークンが解錠キーになる」ことを自覚して入れる。
