import { db } from './_db.js';

export default async function handler(req, res) {
  if (req.method === 'GET' && req.query['hub.challenge']) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.status(200).json({ ok: true });
  try {
    const payload = JSON.stringify({ method: req.method, body: req.body, ts: new Date().toISOString() });
    const sql = db();
    await sql`INSERT INTO agenda_config (clave, valor, nota) VALUES ('debug_ping', ${payload}, 'ping log') ON CONFLICT (clave) DO UPDATE SET valor=${payload}`;
    await sql.end();
  } catch(e) { console.error('[PING-ERR]', e.message); }
}
