export default function handler(req, res) {
  console.log('[PING]', req.method, JSON.stringify(req.body || req.query || {}).slice(0, 500));
  if (req.method === 'GET' && req.query['hub.challenge']) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.status(200).json({ ok: true, method: req.method, ts: new Date().toISOString(), body: req.body });
}
