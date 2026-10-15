# Intervals.icu 読み取り専用 MCP

Garmin Connect から Intervals.icu に同期されたアクティビティ・負荷・Wellnessを、ChatGPT Workから必要なときに取得するためのMCPサーバーです。

## できること

- `get_activities`: 期間内のアクティビティ要約
- `get_activity_detail`: 活動IDで主要指標と最大200区間の詳細を取得
- `get_planned_workouts`: 指定期間のカレンダーにある予定練習を取得（最大200件）
- `get_wellness`: CTL、ATL、フォーム、負荷、HRV、睡眠など
- `get_training_summary`: 競技別の時間・距離・負荷と最新Wellnessをまとめて取得

全ツールは読み取り専用です。予定練習のメニュー本文は1件あたり最大4000文字を返し、長い場合は省略を明示します。GPS座標、元のFITファイル、予定練習の添付ファイル、時系列の生データ、Intervals.icu APIキーはChatGPTへ返しません。Garmin独自の「トレーニングレディネス」「リカバリータイム」「トレーニングステータス」は、従来どおりスクリーンショットで補完します。

## 0. 先にAPIキーを更新

チャットやターミナル履歴に実キーを貼った場合は、Intervals.icuの **Settings > Developer Settings** でキーを再発行してください。以後は `.env` またはクラウドのSecret欄だけに保存します。

## 1. WSLでローカル確認

Node.js 22〜24を使用します。

```bash
cd intervals-icu-mcp
npm ci
cp .env.example .env
```

`.env` をエディタで開き、次だけ変更します。

```dotenv
INTERVALS_API_KEY=再発行した実キー
AUTH_MODE=none
```

起動します。

```bash
set -a
source .env
set +a
npm run build
npm start
```

別ターミナルで確認します。

```bash
curl http://127.0.0.1:3000/healthz
npx @modelcontextprotocol/inspector
```

Inspectorでは Transportを `Streamable HTTP`、URLを `http://127.0.0.1:3000/mcp` にします。まず `get_training_summary` を引数なしで実行します。

> `AUTH_MODE=none` はローカル確認専用です。秘密データを持つこのサーバーを、認証なしのまま恒久公開しないでください。

## 2. Auth0を準備

1. Auth0でテナントを作成し、自分用ユーザーを1名作ります。公開サインアップは無効にします。
2. **Applications > APIs > Create API** を開きます。
3. Nameは `Intervals MCP`、Identifier（Audience）は後で作るRender URL（例 `https://intervals-mcp-xxxx.onrender.com`）、Signing Algorithmは `RS256` にします。
4. APIのPermissionsへ `intervals:read` を追加します。
5. Auth0のDynamic Client Registrationを有効にします。ChatGPTはAuthorization Code + PKCEで接続します。
6. **User Management > Users** で自分の `user_id`（例 `auth0|...`）を控えます。

Render URLは先に仮作成してからAuth0のIdentifierへ戻って設定して構いません。`MCP_RESOURCE_URL`、Auth0 API Identifier、トークンのAudienceは完全一致させます。

## 3. Renderへ配置

1. このフォルダーを非公開GitHubリポジトリへpushします。`.env` は `.gitignore` 済みです。
2. Renderで **New > Blueprint** を選び、リポジトリ内の `render.yaml` を読み込みます。
3. 以下のSecretをRenderのEnvironmentへ入力します。

| Key | Value |
|---|---|
| `INTERVALS_API_KEY` | 再発行したIntervals.icu APIキー |
| `MCP_RESOURCE_URL` | `https://サービス名.onrender.com`（末尾 `/` なし） |
| `AUTH0_ISSUER` | `https://テナント名.jp.auth0.com/` |
| `AUTH0_ALLOWED_SUB` | Auth0の自分の `user_id` |

4. Deploy後に `https://サービス名.onrender.com/healthz` が `status: ok` を返すことを確認します。
5. `https://サービス名.onrender.com/.well-known/oauth-protected-resource` がAuth0情報を返すことを確認します。APIキーはここにもログにも表示されません。

`render.yaml` は有料Starterを指定しています。常時利用とスリープ回避のためです。費用を抑えて試す場合はRender画面でFreeへ変更できますが、初回呼び出しが遅くなることがあります。

## 4. ChatGPT Workへ追加

1. ChatGPTで **Settings > Security and login > Developer mode** を有効にします。
2. **Settings > Plugins** の `+` から開発者モードのAppを作成します。
3. MCP URLへ `https://サービス名.onrender.com/mcp` を指定します。
4. AuthenticationはOAuthを選び、ChatGPTに表示されるCallback URLをAuth0の許可済みCallback URLへ追加します。
5. 接続時にAuth0で自分のユーザーとしてログインし、`intervals:read` を許可します。
6. 新しいチャットで「Intervals.icuから直近42日を取得し、佐渡Aの計画を見直して」と依頼します。

## 5. 日々の運用

Garminでアクティビティを保存するとGarmin ConnectからIntervals.icuへ同期されます。ChatGPTは会話中にMCPを呼ぶたび最新データを取得するため、別途ファイルを手動アップロードする必要はありません。

Garmin独自評価は、週1回または重要セッション前に以下の画面を画像で添付します。

- トレーニングレディネス
- リカバリータイム
- トレーニングステータス／負荷フォーカス

## セキュリティ上の制約

- 本番は `AUTH_MODE=auth0` のまま使用します。
- `AUTH0_ALLOWED_SUB` で自分以外のトークンを拒否します。
- Intervals.icu APIキーはRenderのSecretとしてだけ保存します。
- Renderログ、GitHub、ChatGPTの会話へAPIキーを貼りません。
- APIキーを変更したらRenderのSecretも更新して再デプロイします。

## トラブルシュート

- `401 Intervals.icu authentication failed`: Intervals.icu APIキーを再確認。
- ChatGPTでログイン画面が出ない: Auth0のDiscovery/DCR、MCPのwell-known URL、ツールのOAuth scopeを確認。
- `audience` エラー: `MCP_RESOURCE_URL` とAuth0 API Identifierを完全一致させる。
- `insufficient_scope`: Auth0 APIに `intervals:read` を追加し、再接続。
- WellnessのHRV・睡眠がnull: Intervals.icu側へのGarmin Wellness同期を確認。Garmin独自指標は画像で補完。

## 参考（公式）

- [OpenAI Apps SDK: Authentication](https://developers.openai.com/apps-sdk/build/auth)
- [OpenAI Apps SDK: Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)
- [Intervals.icu Open API](https://www.intervals.icu/features/open-api/)
- [Auth0 Dynamic Client Registration](https://auth0.com/docs/get-started/applications/dynamic-client-registration)
- [Render: Deploy a Node Express app](https://render.com/docs/deploy-node-express-app)
