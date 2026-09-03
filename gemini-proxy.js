const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  },
});

export const onRequest = async ({ request, env }) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405);
  }

  const apiKey = (env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    return jsonResponse({ error: 'GEMINI_API_KEY 未設定' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: '無效的請求格式' }, 400);
  }

  const sourceContent = body?.messages?.[0]?.content;
  if (!Array.isArray(sourceContent) || sourceContent.length === 0) {
    return jsonResponse({ error: '缺少圖片或解析提示' }, 400);
  }

  const input = sourceContent.map((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') {
      return { type: 'text', text: part.text };
    }

    if (part?.type === 'image' && part.source?.type === 'base64') {
      return {
        type: 'image',
        mime_type: part.source.media_type || 'image/jpeg',
        data: part.source.data,
      };
    }

    return null;
  }).filter(Boolean);

  if (!input.some((part) => part.type === 'image') || !input.some((part) => part.type === 'text')) {
    return jsonResponse({ error: '請求必須包含圖片和文字提示' }, 400);
  }

  // 新帳戶已無法使用 Gemini 2.5。環境變數若仍留著舊值，直接改用目前可用的 3.6 Flash。
  const configuredModel = (env.GEMINI_MODEL || '').trim();
  const retiredModels = new Set(['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  const primaryModel = configuredModel && !retiredModels.has(configuredModel)
    ? configuredModel
    : 'gemini-3.6-flash';
  // Interactions API 支援的 Flash 模型依序降級，避免單一熱門模型長時間阻塞。
  const models = [
    primaryModel,
    (env.GEMINI_FALLBACK_MODEL || '').trim(),
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
  ]
    .filter((model, index, list) => model && !retiredModels.has(model) && list.indexOf(model) === index);
  const retryableStatuses = new Set([429, 500, 502, 503, 504, 524]);
  const endpoint = 'https://generativelanguage.googleapis.com/v1beta2/interactions';

  let geminiData = null;
  let model = models[0];
  let lastStatus = 503;
  let lastError = 'Gemini 目前忙碌，請稍後再試';

  for (const candidateModel of models) {
    model = candidateModel;
    let geminiResponse;
    try {
      geminiResponse = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          model,
          input,
          store: false,
          response_format: [{ type: 'text', mime_type: 'application/json' }],
        }),
      });
    } catch (error) {
      lastStatus = 502;
      lastError = `無法連線 Gemini API：${error.message}`;
      continue;
    }

    lastStatus = geminiResponse.status;
    const responseText = await geminiResponse.text();
    try {
      geminiData = JSON.parse(responseText);
    } catch {
      geminiData = null;
      lastError = geminiResponse.status === 524
        ? 'Gemini 回應逾時'
        : `Gemini 回應格式錯誤：${responseText.slice(0, 120)}`;
      if (retryableStatuses.has(geminiResponse.status)) continue;
      return jsonResponse({ error: lastError, retryable: false }, 502);
    }

    if (geminiResponse.ok) break;

    lastError = geminiData?.error?.message || `Gemini API 錯誤 ${geminiResponse.status}`;
    // 模型不存在時，若管理者有設定備援模型則繼續嘗試；沒有備援時直接回傳設定錯誤。
    if (geminiResponse.status === 404 && candidateModel !== models[models.length - 1]) {
      geminiData = null;
      continue;
    }
    if (!retryableStatuses.has(geminiResponse.status)) {
      return jsonResponse({ error: lastError, retryable: false }, geminiResponse.status);
    }
    geminiData = null;
  }

  if (!geminiData) {
    return jsonResponse({
      error: models.length > 1
        ? `${lastError}，系統已嘗試備援模型，請稍候再試`
        : `${lastError}，請稍候再試`,
      retryable: true,
    }, retryableStatuses.has(lastStatus) ? 503 : 502);
  }

  const outputText = (geminiData.steps || [])
    .filter((step) => step?.type === 'model_output')
    .flatMap((step) => step.content || [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text || '')
    .join('')
    .trim();

  if (!outputText) {
    const reason = geminiData.status || '沒有輸出內容';
    return jsonResponse({ error: `Gemini 無法完成解析：${reason}` }, 422);
  }

  // 維持既有前端讀取方式：d.content[0].text
  return jsonResponse({
    content: [{ type: 'text', text: outputText }],
    model,
    usage: geminiData.usage || geminiData.usage_metadata || null,
  });
};
