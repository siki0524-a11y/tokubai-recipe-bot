const express = require('express');
const line = require('@line/bot-sdk');
const fetch = require('node-fetch');

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(lineConfig);

// ユーザーごとの状態管理
// userState[userId] = {
//   items: [],          // 今回の特売品
//   shown: [],          // 今回提案済みレシピ名
//   lastRecipe: null,   // 最後に提案したレシピ（作った/作らない判定用）
//   ngFoods: [],        // NG食材リスト（永続）
//   cookedRecipes: [],  // 作ったレシピ { name, cookedAt }（1ヶ月除外用）
//   mode: null,         // 'ng_setting' など特殊モード
// }
const userState = {};

function getState(userId) {
  if (!userState[userId]) {
    userState[userId] = { items: [], shown: [], lastRecipe: null, ngFoods: [], cookedRecipes: [], mode: null };
  }
  return userState[userId];
}

// 1ヶ月以内に作ったレシピ名リストを返す
function getRecentCooked(state) {
  const oneMonthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return state.cookedRecipes
    .filter(r => r.cookedAt > oneMonthAgo)
    .map(r => r.name);
}

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  res.json({ status: 'ok' });
  const events = req.body.events;
  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      await handleMessage(event);
    }
    // 友だち追加時のウェルカムメッセージ
    if (event.type === 'follow') {
      await client.pushMessage(event.source.userId, [
        {
          type: 'text',
          text: 'はじめまして！\n今日の特売レシピBotです🛒\n\nスーパーの特売品を送るだけで、今夜の夕食レシピを提案します！\n\nまず、使いたくない食材はありますか？',
          quickReply: {
            items: [
              { type: 'action', action: { type: 'message', label: '🚫 NG食材を設定する', text: 'NG食材' } },
              { type: 'action', action: { type: 'message', label: '✅ そのまま使う', text: 'そのまま使う' } },
            ]
          }
        }
      ]);
    }
  }
});

async function handleMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text.trim();
  const state = getState(userId);

  // NG食材設定モード中
  if (state.mode === 'ng_setting') {
    if (text === 'キャンセル') {
      state.mode = null;
      await reply(event, 'キャンセルしました。');
      return;
    }
    if (text === 'クリア') {
      state.ngFoods = [];
      state.mode = null;
      await reply(event, 'NG食材をすべて削除しました！');
      return;
    }
    const newNg = text.split(/[\n、,，\s]+/).map(s => s.trim()).filter(s => s.length > 0);
    state.ngFoods = newNg;
    state.mode = null;
    await reply(event, `NG食材を登録しました！\n\n${newNg.map(f => `・${f}`).join('\n')}\n\n変更したいときは「NG食材」と送ってください。`);
    return;
  }

  // 作った
  if (text === '作った' || text === '作りました') {
    if (state.lastRecipe) {
      state.cookedRecipes.push({ name: state.lastRecipe, cookedAt: Date.now() });
      state.lastRecipe = null;
      await reply(event, 'ありがとうございます！\n1ヶ月間はこのレシピを除外しますね。\nまた特売品を教えてください！');
    } else {
      await reply(event, 'レシピがまだ提案されていません。');
    }
    return;
  }

  // 作らなかった
  if (text === '作らなかった' || text === 'パス') {
    state.lastRecipe = null;
    await reply(event, 'わかりました！\n「別のレシピ」で他のレシピを見るか、「リセット」で食材を変えられます。');
    return;
  }

  // そのまま使う（ウェルカムメッセージから）
  if (text === 'そのまま使う' || text === '特売品入力モード') {
    await reply(event, '今日の特売品を教えてください！\n（複数ある場合は改行か「、」で区切ってください）\n\n例：鶏もも肉、大根、豆腐');
    return;
  }

  // NG食材の確認・設定
  if (text === 'NG食材' || text === 'ng' || text === 'NG') {
    state.mode = 'ng_setting';
    const current = state.ngFoods.length > 0
      ? `現在のNG食材：${state.ngFoods.join('、')}\n\n`
      : '現在NG食材は登録されていません。\n\n';
    await reply(event, `${current}使いたくない食材を送ってください。\n（複数は「、」か改行で区切ってください）\n\n例：ピーマン、魚、レバー\n\n全部削除する場合は「クリア」\nやめる場合は「キャンセル」`);
    return;
  }

  // リセット
  if (text === 'リセット' || text === 'はじめから' || text === 'reset') {
    state.items = [];
    state.shown = [];
    state.lastRecipe = null;
    state.mode = null;
    await reply(event, '食材を入力し直しますね！\n\n今日の特売品を教えてください。\nNG食材を変更したい場合はボタンから。', {
      items: [
        { type: 'action', action: { type: 'message', label: '🚫 NG食材を変更する', text: 'NG食材' } },
      ]
    });
    return;
  }

  // 別のレシピ
  if (text === '別のレシピ' || text === '他のレシピ' || text === 'もう一度') {
    if (state.items && state.items.length > 0) {
      await reply(event, '別のレシピを考えています…');
      const recentCooked = getRecentCooked(state);
      const exclude = [...(state.shown || []), ...recentCooked];
      const recipe = await getRecipe(state.items, exclude, state.ngFoods);
      if (recipe) {
        state.shown = [...(state.shown || []), recipe.name];
        state.lastRecipe = recipe.name;
        await push(userId, formatRecipe(recipe));
        await push(userId, '作りましたか？', recipeQuickReply);
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
    await reply(event, '食材を入力してください\n\n例：鶏もも肉、大根、豆腐');
    return;
  }

  state.items = items;
  state.shown = [];
  state.lastRecipe = null;

  const ngText = state.ngFoods.length > 0 ? `\nNG食材：${state.ngFoods.join('、')}` : '';
  await reply(event, `特売品を受け取りました！\n${items.map(i => `・${i}`).join('\n')}${ngText}\n\nレシピを考えています`);

  const recentCooked = getRecentCooked(state);
  const recipe = await getRecipe(items, recentCooked, state.ngFoods);
  if (recipe) {
    state.shown = [recipe.name];
    state.lastRecipe = recipe.name;
    await push(userId, formatRecipe(recipe));

    // 余り食材の提案
    const leftover = await getLeftoverSuggestion(items, recipe.ingredients);
    if (leftover && leftover.suggestions && leftover.suggestions.length > 0) {
      const suggText = leftover.suggestions
        .map(s => `・${s.type}｜${s.name}\n  ${s.desc}`)
        .join('\n');
      await push(userId, `余った食材の活用アイデア\n\n${suggText}`);
    }

    await push(userId, '作りましたか？', recipeQuickReply);
  } else {
    await push(userId, '申し訳ありません、レシピの取得に失敗しました。もう一度試してみてください。');
  }
}

async function getRecipe(items, exclude, ngFoods) {
  const excludeText = exclude.length > 0
    ? `\n- 以下は除外（提案済み or 最近作った）: 【${exclude.join('、')}】`
    : '';
  const ngText = ngFoods && ngFoods.length > 0
    ? `\n- 以下のNG食材は絶対に使わないこと: 【${ngFoods.join('、')}】`
    : '';

  const prompt = `以下の特売食材を使った夕食レシピを1品提案してください。
特売食材: ${items.join('、')}
対象: 40代、共働き、家族持ちのお母さん。疲れていても作れる、家族が喜ぶもの。

【重要なルール】
- 入力された特売食材はできるだけ全部使うこと（これが最優先）
- 特売食材＋調味料など家にある基本的なもので作れるレシピを優先
- 特別な食材や珍しい調味料が必要なレシピは避ける
- 食材の組み合わせが料理として自然で美味しそうになるよう工夫すること
- どうしても合わない食材だけ除外してOK${excludeText}${ngText}

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
    console.log('Claude API response:', JSON.stringify(data).slice(0, 300));
    if (!data.content) {
      console.error('No content in response:', JSON.stringify(data));
      return null;
    }
    const text = data.content.map(i => i.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('Claude API error:', e);
    return null;
  }
}

async function getLeftoverSuggestion(allItems, usedIngredients) {
  const usedNames = usedIngredients.map(i => i.replace(/[（(].*[)）]/g, '').replace(/\s+\S+$/, '').trim());
  const leftover = allItems.filter(item =>
    !usedNames.some(used => used.includes(item) || item.includes(used))
  );

  if (leftover.length === 0) return null;

  const prompt = `以下の食材が今日のメインレシピで使われませんでした。
余り食材: ${leftover.join('、')}

この食材を使った以下のいずれかを1〜2個提案してください：
- 簡単な副菜・小鉢
- 汁物・味噌汁
- 作り置き・ストック方法

必ずJSONのみで返してください（説明文なし）:
{
  "suggestions": [
    {
      "type": "副菜/汁物/作り置き",
      "name": "料理名または保存方法",
      "desc": "一言説明（30字以内）"
    }
  ]
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
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await res.json();
    if (!data.content) return null;
    const text = data.content.map(i => i.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('Leftover API error:', e);
    return null;
  }
}

function formatRecipe(recipe) {
  const ingredients = recipe.ingredients.map(i => `・${i}`).join('\n');
  const steps = recipe.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');

  return `【${recipe.name}】
時間: ${recipe.time}

${recipe.desc}

【材料】
${ingredients}

【作り方】
${steps}`;
}

// クイックリプライボタンの定義
const recipeQuickReply = {
  items: [
    { type: 'action', action: { type: 'message', label: '✅ 作った', text: '作った' } },
    { type: 'action', action: { type: 'message', label: '⏭ 作らなかった', text: '作らなかった' } },
    { type: 'action', action: { type: 'message', label: '🔄 別のレシピ', text: '別のレシピ' } },
    { type: 'action', action: { type: 'message', label: '🛒 リセット', text: 'リセット' } },
  ]
};

async function reply(event, text, quickReply = null) {
  const message = { type: 'text', text };
  if (quickReply) message.quickReply = quickReply;
  await client.replyMessage(event.replyToken, message);
}

async function push(userId, text, quickReply = null) {
  const message = { type: 'text', text };
  if (quickReply) message.quickReply = quickReply;
  await client.pushMessage(userId, message);
}

// ヘルスチェック
app.get('/', (req, res) => res.send('今日の特売レシピBot 動作中'));

// ============================================================
// リッチメニュー自動セットアップ
// ============================================================
async function setupRichMenu() {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  try {
    // 既存のリッチメニューを全削除
    const listRes = await fetch('https://api.line.me/v2/bot/richmenu/list', { headers });
    const listData = await listRes.json();
    if (listData.richmenus) {
      for (const menu of listData.richmenus) {
        await fetch(`https://api.line.me/v2/bot/richmenu/${menu.richMenuId}`, {
          method: 'DELETE', headers
        });
      }
    }

    // リッチメニュー作成
    const menuRes = await fetch('https://api.line.me/v2/bot/richmenu', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        size: { width: 2500, height: 1686 },
        selected: true,
        name: '特売レシピメニュー',
        chatBarText: 'メニューを開く',
        areas: [
          // 上段左：特売品を入力
          { bounds: { x: 0,    y: 0,    width: 833, height: 843 }, action: { type: 'message', text: '特売品入力モード' } },
          // 上段中：NG食材
          { bounds: { x: 833,  y: 0,    width: 834, height: 843 }, action: { type: 'message', text: 'NG食材' } },
          // 上段右：別のレシピ
          { bounds: { x: 1667, y: 0,    width: 833, height: 843 }, action: { type: 'message', text: '別のレシピ' } },
          // 下段左：作った
          { bounds: { x: 0,    y: 843,  width: 833, height: 843 }, action: { type: 'message', text: '作った' } },
          // 下段中：作らなかった
          { bounds: { x: 833,  y: 843,  width: 834, height: 843 }, action: { type: 'message', text: '作らなかった' } },
          // 下段右：リセット
          { bounds: { x: 1667, y: 843,  width: 833, height: 843 }, action: { type: 'message', text: 'リセット' } },
        ]
      })
    });
    const menuData = await menuRes.json();
    const richMenuId = menuData.richMenuId;
    console.log('リッチメニュー作成:', richMenuId);

    // 画像をアップロード
    const fs = require('fs');
    const path = require('path');
    const imgPath = path.join(__dirname, 'richmenu.png');

    if (fs.existsSync(imgPath)) {
      const imgBuffer = fs.readFileSync(imgPath);
      const imgRes = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
        method: 'POST',
        headers: {
          'Content-Type': 'image/png',
          'Authorization': `Bearer ${token}`
        },
        body: imgBuffer
      });
      console.log('画像アップロード:', imgRes.status);
    } else {
      console.warn('richmenu.png が見つかりません。画像なしで設定します。');
    }

    // デフォルトに設定
    await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
      method: 'POST', headers
    });
    console.log('リッチメニュー設定完了！');

  } catch (e) {
    console.error('リッチメニュー設定エラー:', e);
  }
}

// 特売品入力モードのハンドリング追加
// ※ handleMessage内の食材入力処理の前に「特売品入力モード」を除外
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await setupRichMenu();
});
