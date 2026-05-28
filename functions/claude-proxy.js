const https = require('https');

exports.handler = async function(event, context) {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const CLAUDE_KEY = (process.env.CLAUDE_API_KEY || '').trim().replace(/[^\x20-\x7E]/g, '');
  if (!CLAUDE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API Key 未設定' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: '無效的請求格式' }) };
  }

  const payload = JSON.stringify({
    model: 'claude-opus-4-5',
    max_tokens: 8192,
    messages: body.messages,
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const chunks = [];

    const req = https.request(options, (res) => {
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: res.statusCode,
          headers: { 'Content-Type': 'application/json' },
          body: data,
        });
      });
    });

    req.on('error', (err) => {
      resolve({
        statusCode: 500,
        body: JSON.stringify({ error: err.message }),
      });
    });

    req.setTimeout(25000, () => {
      req.destroy();
      resolve({
        statusCode: 504,
        body: JSON.stringify({ error: '請求逾時，請重試' }),
      });
    });

    req.write(payload);
    req.end();
  });
};
