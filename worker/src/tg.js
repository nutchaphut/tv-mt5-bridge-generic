// Telegram sending. A post with a picture goes out as a photo with the text as its caption; no picture, a text over Telegram's
// 1,024-character caption limit, or a refused upload: the text goes out alone, so a post is never lost to its picture.

export async function sendTelegram(env, text, replyTo) {
  const body = { chat_id: env.TG_CHAT, text };
  if (replyTo) body.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(x => x.json()).catch(() => null);
  return r?.result?.message_id;
}

export async function sendPost(env, text, png) {
  if (png && text.length <= 1024) {
    const f = new FormData();
    f.append('chat_id', env.TG_CHAT); f.append('caption', text);
    f.append('photo', new Blob([png], { type: 'image/png' }), 'chart.png');
    const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendPhoto`, { method: 'POST', body: f }).then(x => x.json()).catch(() => null);
    if (r?.result?.message_id) return r.result.message_id;
  }
  return sendTelegram(env, text);
}
