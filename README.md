# 今日の特売レシピ Bot

LINEで特売品を送ると、AIがレシピを提案してくれるボットです。

## セットアップ手順

### 1. 環境変数（Renderで設定）
- `LINE_CHANNEL_ACCESS_TOKEN` - LINE Developersから取得
- `LINE_CHANNEL_SECRET` - LINE Developersから取得
- `ANTHROPIC_API_KEY` - Anthropicから取得

### 2. 使い方
- 特売品を送信 → レシピ提案
- 「別のレシピ」→ 同じ食材で別のレシピ
- 「リセット」→ 食材を入力し直す
