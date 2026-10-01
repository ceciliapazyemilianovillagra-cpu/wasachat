/**
 * Cron job: corre diariamente a las 10:00 AM (hora Argentina)
 * Busca reservas para mañana y manda recordatorio por WhatsApp
 */
import { db, aplicarPlantilla, fechaBonita } from './_db.js';

const PHONE_NUMBER_ID_TURNO = process.env.WA_PHONE_NUMBER_ID_TURNO;
const ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;

async function enviarMensaje(telefono, texto, phoneId) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: telefono, type: 'text', text: { body: texto } }),
  });
  if (!r.ok) console.error('[CRON-WA] error', await r.text());
}

export default async function handler(req, res) {
  // Solo desde Vercel Cron (header de autorización) o GET interno
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'no autorizado' });
  }

  const sql = db();
  try {
    // Buscar reservas confirmadas/pendientes para mañana
    const manana = await sql`SELECT current_date + 1`;
    const fechaManana = manana[0]['?column?'] || manana[0].column;

    const reservas = await sql`
      SELECT
        r.cliente_telefono,
        r.cliente_nombre,
        r.fecha::text,
        r.hora_inicio::text,
        r.codigo,
        s.nombre AS servicio,
        e.nombre AS especialista,
        n.slug AS negocio_slug,
        (SELECT valor FROM agenda_config WHERE clave='msg_recordatorio' AND (negocio_id = r.negocio_id OR negocio_id IS NULL) LIMIT 1) AS msg_tmpl,
        (SELECT valor FROM agenda_config WHERE clave='moneda' AND (negocio_id = r.negocio_id OR negocio_id IS NULL) LIMIT 1) AS moneda
      FROM agenda_reservas r
      LEFT JOIN agenda_servicios s ON s.id = r.servicio_id
      LEFT JOIN agenda_especialistas e ON e.id = r.especialista_id
      LEFT JOIN negocios n ON n.id = r.negocio_id
      WHERE r.fecha = current_date + 1
        AND r.estado IN ('pendiente', 'confirmada')
        AND r.recordatorio_enviado IS NOT TRUE
    `;

    let enviados = 0;
    for (const r of reservas) {
      const plantilla = r.msg_tmpl ||
        '⏰ *Recordatorio de turno*\n\nMañana tenés:\n📋 *{servicio}*\n👤 {especialista}\n📅 {fecha} a las {hora}\n\nCualquier consulta respondé este mensaje.';
      const msg = aplicarPlantilla(plantilla, {
        servicio: r.servicio || 'Turno',
        especialista: r.especialista || '',
        fecha: fechaBonita(r.fecha),
        hora: r.hora_inicio,
        codigo: r.codigo,
      });
      await enviarMensaje(r.cliente_telefono, msg, PHONE_NUMBER_ID_TURNO);
      await sql`UPDATE agenda_reservas SET recordatorio_enviado=true WHERE codigo=${r.codigo}`;
      enviados++;
    }

    console.log(`[CRON] Recordatorios enviados: ${enviados}`);
    return res.json({ ok: true, enviados });
  } finally {
    await sql.end();
  }
}
