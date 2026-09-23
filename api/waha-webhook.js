/**
 * Webhook receptor de WAHA + lógica del chatbot de reservas.
 *
 * Configurar en WAHA:
 *   URL     : https://tu-app.vercel.app/api/waha-webhook
 *   Events  : message, message.any  (o SCAN_QR_CODE si querés recibir QR por webhook)
 */
import { db, getCfg, row, calcularSlots, proxFechas, generarCodigo, fechaBonita, aplicarPlantilla, minutosDeTime, timeDeMinutos } from './_db.js';

// ── WAHA: enviar mensaje ──────────────────────────────────────────────────────
async function enviarMensaje(cfg, telefono, texto) {
  const base = (cfg.waha_url || process.env.WAHA_URL || 'http://localhost:3000').replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.waha_api_key || process.env.WAHA_API_KEY) {
    headers['X-Api-Key'] = cfg.waha_api_key || process.env.WAHA_API_KEY;
  }
  const chatId = telefono.replace(/\D/g, '') + '@c.us';
  const session = cfg.waha_session || process.env.WAHA_SESSION || 'default';
  try {
    await fetch(`${base}/api/sendText`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ session, chatId, text: texto }),
    });
  } catch (e) {
    console.error('waha enviar error:', e.message);
  }
}

// ── CRM helpers ───────────────────────────────────────────────────────────────
async function upsertContacto(sql, telefono, nombre) {
  return row(await sql`
    INSERT INTO wa_contactos (telefono, nombre)
    VALUES (${telefono}, ${nombre || null})
    ON CONFLICT (telefono) DO UPDATE SET
      nombre = COALESCE(EXCLUDED.nombre, wa_contactos.nombre),
      actualizado = now()
    RETURNING id::text, nombre`);
}

async function getOrCreateConv(sql, contactoId) {
  let conv = row(await sql`
    SELECT id::text, bot_estado, bot_contexto FROM wa_conversaciones
    WHERE contacto_id = ${contactoId} AND estado IN ('bot','abierta')
    ORDER BY ultimo_msg DESC LIMIT 1`);
  if (!conv) {
    conv = row(await sql`
      INSERT INTO wa_conversaciones (contacto_id, estado, bot_estado, bot_contexto)
      VALUES (${contactoId}, 'bot', 'inicio', '{}')
      RETURNING id::text, bot_estado, bot_contexto`);
  }
  return conv;
}

async function guardarMsg(sql, convId, wahaId, dir, contenido) {
  if (!contenido) return;
  await sql`
    INSERT INTO wa_mensajes (conversacion_id, waha_id, direccion, contenido)
    VALUES (${convId}, ${wahaId||null}, ${dir}, ${contenido})
    ON CONFLICT DO NOTHING`;
  await sql`UPDATE wa_conversaciones SET ultimo_msg = now() WHERE id = ${convId}`;
}

async function setBotEstado(sql, convId, estado, ctx) {
  await sql`UPDATE wa_conversaciones SET bot_estado=${estado}, bot_contexto=${JSON.stringify(ctx)} WHERE id=${convId}`;
}

// ── Lógica del chatbot ────────────────────────────────────────────────────────
async function procesarBot(sql, cfg, telefono, nombre, texto, conv) {
  const txt  = texto.trim().toLowerCase();
  const ctx  = typeof conv.bot_contexto === 'object' ? conv.bot_contexto : {};
  const msgs = [];
  let estado = conv.bot_estado;
  let nCtx   = { ...ctx };

  const di  = t => msgs.push(t);
  const neg = cfg.negocio_nombre || 'el negocio';

  // Cualquier estado: "menu" o "hola" reinicia
  const esHola = ['hola','buenas','buenos dias','buenas tardes','buenas noches','hi','hello','inicio','start'].some(s => txt.includes(s));
  const esMenu = txt === 'menu' || txt === 'menú' || txt === '0';

  if (conv.bot_estado === 'inicio' || esHola || esMenu) {
    const plantilla = cfg.msg_bienvenida ||
      `¡Hola {nombre}! 👋 Bienvenido/a a *{negocio}*.\n\n¿En qué puedo ayudarte?\n\n1️⃣ Reservar un turno\n2️⃣ Ver mis reservas\n3️⃣ Cancelar un turno\n4️⃣ Hablar con alguien`;
    di(aplicarPlantilla(plantilla, { nombre: nombre || 'amigo/a', negocio: neg }));
    return { msgs, estado: 'menu', nCtx: {} };
  }

  // ── MENÚ ──
  if (estado === 'menu') {
    if (txt === '1' || txt.includes('reservar') || txt.includes('turno')) {
      const servicios = await sql`SELECT id::text, nombre, duracion_minutos, precio::float8 FROM agenda_servicios WHERE activo ORDER BY orden, nombre`;
      if (!servicios.length) {
        di('Lo siento, no hay servicios disponibles. Contactanos directamente.');
        return { msgs, estado: 'menu', nCtx: {} };
      }
      const lista = servicios.map((s,i) => `${i+1}️⃣ *${s.nombre}* — ${s.duracion_minutos}min — ${cfg.moneda||'$'}${s.precio}`).join('\n');
      di(`¿Qué servicio querés reservar?\n\n${lista}\n\nRespondé con el número.`);
      return { msgs, estado: 'eligiendo_servicio', nCtx: { servicios: servicios.map(s=>({id:s.id,nombre:s.nombre,duracion:s.duracion_minutos,precio:s.precio})) } };
    }
    if (txt === '2' || txt.includes('ver') || txt.includes('mis reservas')) {
      const tel = telefono.replace(/\D/g,'');
      const reservas = await sql`
        SELECT r.codigo, r.fecha::text, r.hora_inicio::text, r.estado, s.nombre AS servicio
        FROM agenda_reservas r LEFT JOIN agenda_servicios s ON s.id=r.servicio_id
        WHERE r.cliente_telefono=${tel} AND r.fecha >= current_date
        ORDER BY r.fecha, r.hora_inicio LIMIT 5`;
      if (!reservas.length) {
        di('No tenés reservas próximas.\n\n1️⃣ Reservar un turno\n0️⃣ Volver al menú');
      } else {
        const lista = reservas.map(r=>`📋 *${r.servicio}*\n📅 ${fechaBonita(r.fecha)} a las ${r.hora_inicio}\n🔖 ${r.codigo} — _${r.estado}_`).join('\n\n');
        di(`Tus próximas reservas:\n\n${lista}\n\nEscribí *cancelar CÓDIGO* para cancelar alguna.`);
      }
      return { msgs, estado: 'menu', nCtx: {} };
    }
    if (txt === '3' || txt.startsWith('cancelar')) {
      const match = texto.toUpperCase().match(/RES-[A-Z0-9]+/);
      if (match) {
        // Cancelación directa con código
        return await cancelarReserva(sql, cfg, telefono, match[0], msgs);
      }
      di('¿Qué reserva querés cancelar? Enviame el código (ej: *RES-AB1234*)');
      return { msgs, estado: 'cancelando', nCtx: {} };
    }
    if (txt === '4' || txt.includes('hablar') || txt.includes('humano') || txt.includes('persona')) {
      di(`Perfecto, te conecto con alguien de *${neg}*.\n\nEscribinos al ${cfg.negocio_whatsapp || 'nuestro número'} o respondé este chat y te atendemos a la brevedad. 🙌`);
      return { msgs, estado: 'humano', nCtx: {} };
    }
    di('No entendí. Por favor elegí una opción:\n\n1️⃣ Reservar un turno\n2️⃣ Ver mis reservas\n3️⃣ Cancelar un turno\n4️⃣ Hablar con alguien');
    return { msgs, estado: 'menu', nCtx: {} };
  }

  // ── ELIGIENDO SERVICIO ──
  if (estado === 'eligiendo_servicio') {
    const n = parseInt(txt) - 1;
    const servicios = ctx.servicios || [];
    if (isNaN(n) || n < 0 || n >= servicios.length) {
      di(`Por favor respondé con un número del 1 al ${servicios.length}.`);
      return { msgs, estado, nCtx: ctx };
    }
    nCtx = { ...ctx, servicio: servicios[n] };
    const todos = await sql`SELECT id::text, nombre FROM agenda_especialistas WHERE activo ORDER BY orden, nombre`;
    if (todos.length === 1) {
      nCtx.especialista = todos[0];
      const fechas = await proxFechas(sql, cfg, todos[0].id, servicios[n].duracion);
      if (!fechas.length) {
        di(`No hay disponibilidad para *${servicios[n].nombre}* en los próximos días. Escribinos para coordinar.`);
        return { msgs, estado: 'menu', nCtx: {} };
      }
      nCtx.fechas = fechas;
      di(`¿Qué día preferís?\n\n${fechas.map((f,i)=>`${i+1}️⃣ ${fechaBonita(f)}`).join('\n')}\n\nRespondé con el número.`);
      return { msgs, estado: 'eligiendo_fecha', nCtx };
    }
    nCtx.especialistas = todos;
    di(`¿Con quién querés atenderte?\n\n${todos.map((e,i)=>`${i+1}️⃣ ${e.nombre}`).join('\n')}\n\nRespondé con el número.`);
    return { msgs, estado: 'eligiendo_especialista', nCtx };
  }

  // ── ELIGIENDO ESPECIALISTA ──
  if (estado === 'eligiendo_especialista') {
    const n = parseInt(txt) - 1;
    const esps = ctx.especialistas || [];
    if (isNaN(n) || n < 0 || n >= esps.length) {
      di(`Respondé con un número del 1 al ${esps.length}.`);
      return { msgs, estado, nCtx: ctx };
    }
    nCtx = { ...ctx, especialista: esps[n] };
    const fechas = await proxFechas(sql, cfg, esps[n].id, ctx.servicio.duracion);
    if (!fechas.length) {
      di(`No hay disponibilidad con *${esps[n].nombre}* en los próximos días.\n\n0️⃣ Volver al menú`);
      return { msgs, estado: 'menu', nCtx: {} };
    }
    nCtx.fechas = fechas;
    di(`¿Qué día preferís con *${esps[n].nombre}*?\n\n${fechas.map((f,i)=>`${i+1}️⃣ ${fechaBonita(f)}`).join('\n')}\n\nRespondé con el número.`);
    return { msgs, estado: 'eligiendo_fecha', nCtx };
  }

  // ── ELIGIENDO FECHA ──
  if (estado === 'eligiendo_fecha') {
    const n = parseInt(txt) - 1;
    const fechas = ctx.fechas || [];
    if (isNaN(n) || n < 0 || n >= fechas.length) {
      di(`Respondé con un número del 1 al ${fechas.length}.`);
      return { msgs, estado, nCtx: ctx };
    }
    const fecha = fechas[n];
    const slots = await calcularSlots(sql, ctx.especialista.id, fecha, ctx.servicio.duracion,
      Number(cfg.intervalo_turnos_minutos)||30,
      (Number(cfg.anticipacion_minima_horas)||0)*3600000);
    if (!slots.length) {
      di(`Ups, ese día ya no tiene horarios. Elegí otro:\n\n${fechas.map((f,i)=>`${i+1}️⃣ ${fechaBonita(f)}`).join('\n')}`);
      return { msgs, estado, nCtx: ctx };
    }
    nCtx = { ...ctx, fecha, slots };
    di(`Horarios disponibles el *${fechaBonita(fecha)}*:\n\n${slots.map((s,i)=>`${i+1}️⃣ ${s}`).join('\n')}\n\nRespondé con el número.`);
    return { msgs, estado: 'eligiendo_hora', nCtx };
  }

  // ── ELIGIENDO HORA ──
  if (estado === 'eligiendo_hora') {
    const n = parseInt(txt) - 1;
    const slots = ctx.slots || [];
    if (isNaN(n) || n < 0 || n >= slots.length) {
      di(`Respondé con un número del 1 al ${slots.length}.`);
      return { msgs, estado, nCtx: ctx };
    }
    nCtx = { ...ctx, hora: slots[n] };
    di(`Confirmá tu reserva:\n\n📋 *${ctx.servicio.nombre}*\n👤 ${ctx.especialista.nombre}\n📅 ${fechaBonita(ctx.fecha)}\n🕐 ${slots[n]}\n💰 ${cfg.moneda||'$'}${ctx.servicio.precio}\n\n¿Confirmamos?\n\n1️⃣ Sí, confirmar ✅\n2️⃣ No, cambiar ❌`);
    return { msgs, estado: 'confirmando', nCtx };
  }

  // ── CONFIRMANDO ──
  if (estado === 'confirmando') {
    if (txt === '2' || txt === 'no' || txt.includes('cambiar') || txt.includes('cancelar')) {
      di('¿Qué querés cambiar?\n\n1️⃣ El horario\n2️⃣ El día\n3️⃣ Volver al menú principal');
      return { msgs, estado: 'rehaciendo', nCtx: ctx };
    }
    if (txt === '1' || txt === 'si' || txt === 'sí' || txt.includes('confirm') || txt === 'ok') {
      const { servicio, especialista, fecha, hora } = ctx;
      const tel = telefono.replace(/\D/g,'');
      const minI = minutosDeTime(hora);
      const horaFin = timeDeMinutos(minI + servicio.duracion);
      const codigo = generarCodigo();
      try {
        await sql`
          INSERT INTO agenda_reservas
            (codigo, especialista_id, servicio_id, fecha, hora_inicio, hora_fin,
             cliente_nombre, cliente_telefono, estado, origen)
          VALUES
            (${codigo}, ${especialista.id}, ${servicio.id}, ${fecha}::date,
             ${hora}::time, ${horaFin}::time,
             ${nombre || 'Cliente WhatsApp'}, ${tel}, 'pendiente', 'whatsapp')`;
        const plantilla = cfg.msg_confirmacion ||
          '✅ ¡Reserva confirmada!\n\n📋 *{servicio}*\n👤 {especialista}\n📅 {fecha}\n🕐 {hora}\n💰 {precio}\n\nCódigo: *{codigo}*\n\n¡Te esperamos en {negocio}! 🎉';
        di(aplicarPlantilla(plantilla, {
          servicio: servicio.nombre, especialista: especialista.nombre,
          fecha: fechaBonita(fecha), hora, horaFin,
          precio: `${cfg.moneda||'$'}${servicio.precio}`,
          codigo, negocio: neg,
        }));
        return { msgs, estado: 'completado', nCtx: {} };
      } catch (e) {
        di('Hubo un error al guardar la reserva. Por favor intentá de nuevo o contactanos directamente.');
        return { msgs, estado: 'menu', nCtx: {} };
      }
    }
    di('Respondé *1* para confirmar o *2* para cambiar.');
    return { msgs, estado, nCtx: ctx };
  }

  // ── REHACIENDO ──
  if (estado === 'rehaciendo') {
    if (txt === '1') {
      const slots = await calcularSlots(sql, ctx.especialista.id, ctx.fecha, ctx.servicio.duracion,
        Number(cfg.intervalo_turnos_minutos)||30, (Number(cfg.anticipacion_minima_horas)||0)*3600000);
      nCtx = { ...ctx, slots };
      di(`Horarios disponibles el *${fechaBonita(ctx.fecha)}*:\n\n${slots.map((s,i)=>`${i+1}️⃣ ${s}`).join('\n')}`);
      return { msgs, estado: 'eligiendo_hora', nCtx };
    }
    if (txt === '2') {
      const fechas = await proxFechas(sql, cfg, ctx.especialista.id, ctx.servicio.duracion);
      nCtx = { ...ctx, fechas };
      di(`¿Qué día preferís?\n\n${fechas.map((f,i)=>`${i+1}️⃣ ${fechaBonita(f)}`).join('\n')}`);
      return { msgs, estado: 'eligiendo_fecha', nCtx };
    }
    di(`¿En qué puedo ayudarte?\n\n1️⃣ Reservar\n2️⃣ Ver mis reservas\n3️⃣ Cancelar`);
    return { msgs, estado: 'menu', nCtx: {} };
  }

  // ── CANCELANDO ──
  if (estado === 'cancelando') {
    const match = texto.toUpperCase().match(/RES-[A-Z0-9]+/);
    const codigo = match ? match[0] : texto.toUpperCase().trim();
    return await cancelarReserva(sql, cfg, telefono, codigo, msgs);
  }

  // ── COMPLETADO / HUMANO / fallback ──
  di(`¿En qué más puedo ayudarte?\n\n1️⃣ Reservar un turno\n2️⃣ Ver mis reservas\n3️⃣ Cancelar un turno\n0️⃣ Menú principal`);
  return { msgs, estado: 'menu', nCtx: {} };
}

async function cancelarReserva(sql, cfg, telefono, codigo, msgs) {
  const tel = telefono.replace(/\D/g,'');
  const r = row(await sql`
    SELECT r.id::text, r.codigo, r.fecha::text, r.hora_inicio::text, r.estado
    FROM agenda_reservas r
    WHERE r.codigo=${codigo} AND r.cliente_telefono=${tel}`);
  if (!r) {
    msgs.push(`No encontré una reserva con código *${codigo}* para tu número.\n\nVerificá el código o escribí *menu* para volver al inicio.`);
    return { msgs, estado: 'menu', nCtx: {} };
  }
  if (r.estado === 'cancelada') {
    msgs.push(`La reserva *${codigo}* ya estaba cancelada.`);
    return { msgs, estado: 'menu', nCtx: {} };
  }
  await sql`UPDATE agenda_reservas SET estado='cancelada' WHERE id=${r.id}`;
  const plantilla = cfg.msg_cancelacion || '❌ Tu reserva *{codigo}* del {fecha} a las {hora} fue cancelada.\n\nEscribinos cuando quieras para reprogramar.';
  msgs.push(aplicarPlantilla(plantilla, { codigo, fecha: fechaBonita(r.fecha), hora: r.hora_inicio }));
  return { msgs, estado: 'menu', nCtx: {} };
}

// ── Handler principal ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ ok: true, status: 'webhook activo ✅' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    if (!process.env.DATABASE_URL) throw Error('Falta DATABASE_URL');
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

    // Filtrar solo eventos de mensajes entrantes
    const event = body.event || body.type || '';
    if (!event.startsWith('message')) return res.status(200).json({ ok: true, ignored: 'no es mensaje' });
    const payload = body.payload || body;
    if (payload.fromMe || payload.from_me) return res.status(200).json({ ok: true, ignored: 'propio' });

    const from    = (payload.from || payload.chatId || '').replace('@c.us','').replace(/\D/g,'');
    if (!from) return res.status(200).json({ ok: true, ignored: 'sin teléfono' });

    const texto   = payload.body || payload.text?.body || payload.caption || '';
    if (!texto)   return res.status(200).json({ ok: true, ignored: 'sin texto' });

    const wahaId  = payload.id || null;
    const pushName = payload.notifyName || '';

    const sql = db();
    await sql`SET timezone='America/Argentina/Buenos_Aires'`;
    const cfg = await getCfg(sql);

    const contacto = await upsertContacto(sql, from, pushName);
    const conv     = await getOrCreateConv(sql, contacto.id);

    await guardarMsg(sql, conv.id, wahaId, 'entrante', texto);

    const { msgs, estado, nCtx } = await procesarBot(sql, cfg, from, contacto.nombre || pushName, texto, conv);

    await setBotEstado(sql, conv.id, estado, nCtx);

    for (const m of msgs) {
      await enviarMensaje(cfg, from, m);
      await guardarMsg(sql, conv.id, null, 'saliente', m);
    }

    return res.status(200).json({ ok: true, mensajes: msgs.length });
  } catch (e) {
    console.error('[waha-webhook]', e.message);
    return res.status(200).json({ ok: true, error: e.message }); // 200 para que WAHA no reintente
  }
}
