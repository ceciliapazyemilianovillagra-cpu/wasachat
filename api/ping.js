export default function handler(req, res) {
  console.log('[PING]', req.method, JSON.stringify(req.body || {}).slice(0, 300));
  res.status(200).json({ method: req.method, ts: new Date().toISOString(), body: req.body });
}
