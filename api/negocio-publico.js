import { db } from './_db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug requerido' });

  const sql = db();
  try {
    const rows = await sql`
      SELECT id, slug, nombre, descripcion, logo_url, whatsapp, pausado
      FROM negocios
      WHERE slug = ${slug} AND activo = true
      LIMIT 1
    `;
    if (!rows.length) return res.status(404).json({ error: 'no encontrado' });
    return res.json(rows[0]);
  } finally {
    await sql.end();
  }
}
