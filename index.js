const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(lineConfig);

// ユーザーごとの入力状態を管理
const userState = {};

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  res.json({ status: 'ok' });
  const events = req.body.events;
  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      await handleMessage(event);
    }
  }
});

async function handleMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text.trim();

  // リセットコマンド
  if (text === 'リセット' || text === 'はじめから' || text === 'reset') {
    userState[userId] = null;
    await reply(event, '🛒 食材を入力し直しますね！\n\n今日の特売品を教えてください。\n（複数ある場合は改行か「、」で区切ってください）\n\n例：\n鶏もも肉\n大根\n豆腐');
    return;
  }

  // 別のレシピ
  if (text === '別のレシピ' || text === '他のレシピ' || text === 'もう一度') {
    if (userState[userId] && userState[userId].items) {
      await reply(event, '🔄 別のレシピを考えています…');
      const recipe = await getRecipe(userState[userId].items, userState[userId].shown || []);
      if (recipe) {
        userState[userId].shown = [...(userState[userId].shown || []), recipe.name];
        await reply(event, formatRecipe(recipe));
        await reply(event, '他にも見たい場合は「別のレシピ」\n食材を変えたい場合は「リセット」と送ってください 🙌');
      }
    } else {
      await reply(event, 'まず特売品を教えてください！');
    }
    return;
  }

  // 食材入力として処理
  const items = text
    .split(/[\n、,，\s]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .slice(0, 5);

  if (items.length === 0) {
    await reply(event, '食材を入力してください 😊\n\n例：鶏もも肉、大根、豆腐');
    return;
  }

  userState[userId] = { items, shown: [] };

  await reply(event, `📝 特売品を受け取りました！\n${items.map(i => `・${i}`).join('\n')}\n\nレシピを考えています🍳`);

  const recipe = await getRecipe(items, []);
  if (recipe) {
    userState[userId].shown = [recipe.name];
    await reply(event, formatRecipe(recipe));
    await reply(event, '他にも見たい場合は「別のレシピ」\n食材を変えたい場合は「リセット」と送ってください 🙌');
  } else {
    await reply(event, '申し訳ありません、レシピの取得に失敗しました。もう一度試してみてください。');
  }
}

async function getRecipe(items, shown) {
  const excludeText = shown.length > 0
    ? `\n- 以下は提案済みなので除外: 【${shown.join('、')}】`
    : '';

  const prompt = `以下の特売食材を使った夕食レシピを1品提案してください。
特売食材: ${items.join('、')}
対象: 40代、共働き、家族持ちのお母さん。疲れていても作れる、家族が喜ぶもの。

【重要なルール】
- 材料はできるだけ少なく、最大5つまでに厳選すること
- 特売食材＋調味料など家にある基本的なもので作れるレシピを最優先
- 特別な食材や珍しい調味料が必要なレシピは避ける${excludeText}

必ずJSONのみで返してください（説明文なし）:
{
  "name": "料理名",
  "time": "調理時間（例:20分）",
  "desc": "この料理のポイント（50字以内）",
  "ingredients": ["材料と分量1", "材料と分量2", "材料と分量3"],
  "steps": ["手順1", "手順2", "手順3", "手順4"]
}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await res.json();
    const text = data.content.map(i => i.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('Claude API error:', e);
    return null;
  }
}

function formatRecipe(recipe) {
  const ingredients = recipe.ingredients.map(i => `・${i}`).join('\n');
  const steps = recipe.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');

  return `🍽️ *${recipe.name}*
⏱ ${recipe.time}

💡 ${recipe.desc}

【材料】
${ingredients}

【作り方】
${steps}`;
}

async function reply(event, text) {
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text
  });
}

// ヘルスチェック
app.get('/', (req, res) => res.send('今日の特売レシピBot 動作中 🍳'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
