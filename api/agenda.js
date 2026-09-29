import { db, getCfg, row, txt, calcularSlots, generarCodigo, fechaBonita } from './_db.js';

function adminOk(req, p) {
  const secret = process.env.AGENDA_ADMIN_SECRET;
  return secret && (req.headers['x-admin-secret'] === secret || p.admin_secret === secret);
}

const ACCIONES_ADMIN = new Set([
  'getReservasAdmin','updateReserva','getConfig','saveConfig',
  'listEspecialistas','saveEspecialista','deleteEspecialista',
  'listServicios','saveServicio','deleteServicio',
  'listHorarios','saveHorario','deleteHorario',
  'listBloqueos','saveBloqueo','deleteBloqueo',
  'getMetricas','getCrmContactos','getCrmConversaciones','getCrmMensajes',
  'updateContacto','sendWhatsApp',
]);

export default async function handler(req, res) {
  try {
    if (!process.env.DATABASE_URL) throw Error('Falta DATABASE_URL');
    const sql = db();
    const p = { ...req.query, ...(typeof req.body === 'object' && req.body ? req.body : {}) };

    if (ACCIONES_ADMIN.has(p.action) && !adminOk(req, p)) {
      return res.status(401).json({ ok: false, error: 'No autorizado' });
    }

    let data;

    switch (p.action) {

      // ── PÚBLICO ───────────────────────────────────────────────────────────

      case 'getDatosIniciales': {
        const [cfg, especialistas, servicios] = await Promise.all([
          getCfg(sql),
          sql`SELECT id::text, nombre, foto_url, color FROM agenda_especialistas WHERE activo ORDER BY orden, nombre`,
          sql`SELECT id::text, nombre, descripcion, duracion_minutos, precio::float8, especialista_id::text FROM agenda_servicios WHERE activo ORDER BY orden, nombre`,
        ]);
        data = { cfg, especialistas, servicios };
        break;
      }

      case 'getDisponibilidad': {
        const { especialista_id, servicio_id, fecha } = p;
        if (!especialista_id || !servicio_id || !fecha) throw Error('Faltan parámetros');
        const cfg = await getCfg(sql);
        const srv = row(await sql`SELECT duracion_minutos FROM agenda_servicios WHERE id=${servicio_id} AND activo`);
        if (!srv) throw Error('Servicio no disponible');
        const slots = await calcularSlots(sql, especialista_id, fecha, srv.duracion_minutos,
          Number(cfg.intervalo_turnos_minutos) || 30,
          (Number(cfg.anticipacion_minima_horas) || 0) * 3600000);
        data = { slots, fecha };
        break;
      }

      case 'crearReserva': {
        const { especialista_id, servicio_id, fecha, hora, nombre, telefono, email, notas, origen } = p;
        if (!especialista_id || !servicio_id) throw Error('Faltan especialista o servicio');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) throw Error('Fecha inválida');
        if (!/^\d{2}:\d{2}$/.test(hora || '')) throw Error('Hora inválida');
        txt(nombre, 'Nombre');
        const tel = String(telefono || '').replace(/\D/g, '');
        if (tel.length < 8) throw Error('Teléfono inválido (incluí código de país)');

        const cfg = await getCfg(sql);
        const [srv, esp] = await Promise.all([
          sql`SELECT duracion_minutos, nombre, precio::float8 FROM agenda_servicios WHERE id=${servicio_id} AND activo`.then(row),
          sql`SELECT nombre FROM agenda_especialistas WHERE id=${especialista_id} AND activo`.then(row),
        ]);
        if (!srv) throw Error('Servicio no disponible');
        if (!esp) throw Error('Especialista no disponible');

        const slots = await calcularSlots(sql, especialista_id, fecha, srv.duracion_minutos,
          Number(cfg.intervalo_turnos_minutos) || 30,
          (Number(cfg.anticipacion_minima_horas) || 0) * 3600000);
        if (!slots.includes(hora)) throw Error('Ese horario ya no está disponible. Elegí otro.');

        const [h, m] = hora.split(':');
        const minInicio = Number(h) * 60 + Number(m);
        const horaFin = `${String(Math.floor((minInicio + srv.duracion_minutos) / 60)).padStart(2,'0')}:${String((minInicio + srv.duracion_minutos) % 60).padStart(2,'0')}`;
        const codigo = generarCodigo();

        const reserva = row(await sql`
          INSERT INTO agenda_reservas
            (codigo, especialista_id, servicio_id, fecha, hora_inicio, hora_fin,
             cliente_nombre, cliente_telefono, cliente_email, notas, origen)
          VALUES
            (${codigo}, ${especialista_id}, ${servicio_id}, ${fecha}::date,
             ${hora}::time, ${horaFin}::time, ${String(nombre).trim()}, ${tel},
             ${email ? String(email).trim() : null}, ${notas || null}, ${origen || 'web'})
          RETURNING id::text, codigo, fecha::text, hora_inicio::text, hora_fin::text, estado`);

        // Upsert contacto CRM
        await sql`
          INSERT INTO wa_contactos (telefono, nombre) VALUES (${tel}, ${String(nombre).trim()})
          ON CONFLICT (telefono) DO UPDATE SET
            nombre = COALESCE(EXCLUDED.nombre, wa_contactos.nombre),
            actualizado = now()`;

        data = { ...reserva, resumen: { servicio: srv.nombre, especialista: esp.nombre, fecha: fechaBonita(fecha), hora, horaFin, precio: srv.precio, moneda: cfg.moneda || '$' } };
        break;
      }

      case 'getReserva': {
        const r = row(await sql`
          SELECT r.id::text, r.codigo, r.fecha::text, r.hora_inicio::text, r.hora_fin::text,
                 r.estado, r.cliente_nombre, r.cliente_telefono, r.notas,
                 e.nombre AS especialista, s.nombre AS servicio, s.precio::float8 AS precio
          FROM agenda_reservas r
          LEFT JOIN agenda_especialistas e ON e.id = r.especialista_id
          LEFT JOIN agenda_servicios s ON s.id = r.servicio_id
          WHERE r.codigo = ${txt(p.codigo, 'Código')}`);
        if (!r) throw Error('Reserva no encontrada');
        data = r;
        break;
      }

      // ── ADMIN ─────────────────────────────────────────────────────────────

      case 'getReservasAdmin': {
        const est = p.estado && p.estado !== 'todas' ? p.estado : null;
        data = await sql`
          SELECT r.id::text, r.codigo, r.fecha::text, r.hora_inicio::text, r.hora_fin::text,
                 r.estado, r.origen, r.cliente_nombre, r.cliente_telefono, r.cliente_email,
                 r.notas, r.creado::text, r.actualizado::text,
                 e.nombre AS especialista, e.id::text AS especialista_id,
                 s.nombre AS servicio, s.precio::float8 AS precio
          FROM agenda_reservas r
          LEFT JOIN agenda_especialistas e ON e.id = r.especialista_id
          LEFT JOIN agenda_servicios s ON s.id = r.servicio_id
          WHERE (${est}::text IS NULL OR r.estado = ${est})
          ORDER BY r.fecha DESC, r.hora_inicio DESC LIMIT 300`;
        break;
      }

      case 'updateReserva': {
        const campos = {};
        if (p.estado) campos.estado = p.estado;
        if (p.notas !== undefined) campos.notas = p.notas;
        if (!Object.keys(campos).length) throw Error('Nada que actualizar');
        data = row(await sql`
          UPDATE agenda_reservas SET ${sql(campos)} WHERE id = ${p.id}
          RETURNING id::text, codigo, estado, notas, actualizado::text`);
        break;
      }

      case 'getConfig':
        data = await sql`SELECT clave, valor, nota FROM agenda_config ORDER BY clave`;
        break;

      case 'saveConfig': {
        const cambios = typeof p.cambios === 'object' ? p.cambios : JSON.parse(p.cambios || '{}');
        for (const [clave, valor] of Object.entries(cambios))
          await sql`UPDATE agenda_config SET valor = ${String(valor)} WHERE clave = ${clave}`;
        data = { actualizadas: Object.keys(cambios).length };
        break;
      }

      case 'listEspecialistas':
        data = await sql`SELECT id::text, nombre, foto_url, color, activo, orden FROM agenda_especialistas ORDER BY orden, nombre`;
        break;

      case 'saveEspecialista': {
        const c = { nombre: txt(p.nombre,'Nombre'), foto_url: p.foto_url||null, color: p.color||'#1B4332', activo: p.activo!==false && p.activo!=='false', orden: Number(p.orden)||0 };
        data = p.id
          ? row(await sql`UPDATE agenda_especialistas SET ${sql(c)} WHERE id=${p.id} RETURNING id::text, nombre`)
          : row(await sql`INSERT INTO agenda_especialistas ${sql(c)} RETURNING id::text, nombre`);
        break;
      }

      case 'deleteEspecialista':
        await sql`DELETE FROM agenda_especialistas WHERE id=${p.id}`;
        data = { deleted: true };
        break;

      case 'listServicios':
        data = await sql`SELECT id::text, nombre, descripcion, duracion_minutos, precio::float8, especialista_id::text, activo, orden FROM agenda_servicios ORDER BY orden, nombre`;
        break;

      case 'saveServicio': {
        const c = { nombre: txt(p.nombre,'Nombre'), descripcion: p.descripcion||null, duracion_minutos: Math.max(5,Number(p.duracion_minutos)||30), precio: Number(p.precio)||0, especialista_id: p.especialista_id||null, activo: p.activo!==false && p.activo!=='false', orden: Number(p.orden)||0 };
        data = p.id
          ? row(await sql`UPDATE agenda_servicios SET ${sql(c)} WHERE id=${p.id} RETURNING id::text, nombre`)
          : row(await sql`INSERT INTO agenda_servicios ${sql(c)} RETURNING id::text, nombre`);
        break;
      }

      case 'deleteServicio':
        await sql`DELETE FROM agenda_servicios WHERE id=${p.id}`;
        data = { deleted: true };
        break;

      case 'listHorarios':
        data = await sql`SELECT id::text, especialista_id::text, dia_semana, hora_inicio::text, hora_fin::text, activo FROM agenda_horarios ORDER BY especialista_id, dia_semana, hora_inicio`;
        break;

      case 'saveHorario': {
        const c = { especialista_id: txt(p.especialista_id,'Especialista'), dia_semana: txt(p.dia_semana,'Día'), hora_inicio: txt(p.hora_inicio,'Hora inicio'), hora_fin: txt(p.hora_fin,'Hora fin'), activo: p.activo!==false };
        data = p.id
          ? row(await sql`UPDATE agenda_horarios SET ${sql(c)} WHERE id=${p.id} RETURNING id::text`)
          : row(await sql`INSERT INTO agenda_horarios ${sql(c)} RETURNING id::text`);
        break;
      }

      case 'deleteHorario':
        await sql`DELETE FROM agenda_horarios WHERE id=${p.id}`;
        data = { deleted: true };
        break;

      case 'listBloqueos':
        data = await sql`SELECT id::text, especialista_id, fecha_inicio::text, fecha_fin::text, hora_inicio::text, hora_fin::text, motivo FROM agenda_bloqueos ORDER BY fecha_inicio DESC`;
        break;

      case 'saveBloqueo': {
        const c = { especialista_id: p.especialista_id||'TODOS', fecha_inicio: txt(p.fecha_inicio,'Fecha inicio'), fecha_fin: txt(p.fecha_fin,'Fecha fin'), hora_inicio: p.hora_inicio||null, hora_fin: p.hora_fin||null, motivo: p.motivo||null };
        data = p.id
          ? row(await sql`UPDATE agenda_bloqueos SET ${sql(c)} WHERE id=${p.id} RETURNING id::text`)
          : row(await sql`INSERT INTO agenda_bloqueos ${sql(c)} RETURNING id::text`);
        break;
      }

      case 'deleteBloqueo':
        await sql`DELETE FROM agenda_bloqueos WHERE id=${p.id}`;
        data = { deleted: true };
        break;

      case 'getMetricas': {
        const hoy = new Date().toLocaleDateString('en-CA');
        const [hoyR, pend, mes] = await Promise.all([
          sql`SELECT count(*)::int AS n FROM agenda_reservas WHERE fecha=${hoy}::date AND estado != 'cancelada'`,
          sql`SELECT count(*)::int AS n FROM agenda_reservas WHERE estado='pendiente'`,
          sql`SELECT count(*)::int AS total,
                     count(*) FILTER (WHERE estado='cancelada')::int AS canceladas,
                     COALESCE(SUM(s.precio) FILTER (WHERE r.estado IN ('confirmada','completada')),0)::float8 AS ingreso
              FROM agenda_reservas r LEFT JOIN agenda_servicios s ON s.id=r.servicio_id
              WHERE date_trunc('month',r.fecha) = date_trunc('month',current_date)`,
        ]);
        const m = mes[0];
        data = { reservasHoy: hoyR[0].n, pendientes: pend[0].n, totalMes: m.total, canceladasMes: m.canceladas, ingresoMes: m.ingreso, tasaCancelacion: m.total > 0 ? Math.round(m.canceladas/m.total*100) : 0 };
        break;
      }

      case 'getCrmContactos': {
        const q = p.q ? `%${p.q}%` : null;
        data = await sql`
          SELECT c.id::text, c.telefono, c.nombre, c.email, c.etiquetas, c.estado,
                 c.notas, c.creado::text, c.actualizado::text,
                 count(DISTINCT r.id)::int AS total_reservas,
                 max(r.fecha)::text AS ultima_reserva
          FROM wa_contactos c
          LEFT JOIN agenda_reservas r ON r.cliente_telefono = c.telefono
          WHERE (${q}::text IS NULL OR c.nombre ILIKE ${q} OR c.telefono ILIKE ${q})
          GROUP BY c.id ORDER BY c.actualizado DESC LIMIT 100`;
        break;
      }

      case 'updateContacto': {
        const c = {};
        if (p.nombre !== undefined) c.nombre = p.nombre;
        if (p.email  !== undefined) c.email  = p.email;
        if (p.notas  !== undefined) c.notas  = p.notas;
        if (p.estado !== undefined) c.estado = p.estado;
        if (p.etiquetas !== undefined) c.etiquetas = typeof p.etiquetas === 'string' ? p.etiquetas.split(',').map(s=>s.trim()).filter(Boolean) : p.etiquetas;
        c.actualizado = new Date();
        data = row(await sql`UPDATE wa_contactos SET ${sql(c)} WHERE id=${p.id} RETURNING id::text, nombre, estado`);
        break;
      }

      case 'getCrmConversaciones': {
        data = await sql`
          SELECT conv.id::text, conv.estado, conv.bot_estado, conv.ultimo_msg::text AS ultimo_mensaje,
                 c.nombre AS contacto_nombre, c.telefono,
                 (SELECT count(*)::int FROM wa_mensajes m WHERE m.conversacion_id=conv.id) AS total_mensajes
          FROM wa_conversaciones conv
          JOIN wa_contactos c ON c.id = conv.contacto_id
          ORDER BY conv.ultimo_msg DESC LIMIT 100`;
        break;
      }

      case 'getCrmMensajes': {
        if (!p.conversacion_id) throw Error('Falta conversacion_id');
        data = await sql`
          SELECT id::text, direccion, tipo, contenido, creado::text
          FROM wa_mensajes WHERE conversacion_id=${p.conversacion_id}
          ORDER BY creado ASC`;
        break;
      }

      case 'sendWhatsApp': {
        if (!p.telefono || !p.mensaje) throw Error('Falta telefono o mensaje');
        const PHONE_ID = process.env.WA_PHONE_NUMBER_ID;
        const TOKEN    = process.env.WA_ACCESS_TOKEN;
        if (!PHONE_ID || !TOKEN) throw Error('Variables WA no configuradas');
        const waRes = await fetch(`https://graph.facebook.com/v21.0/${PHONE_ID}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: p.telefono, type: 'text', text: { body: p.mensaje } }),
        });
        if (!waRes.ok) {
          const err = await waRes.json().catch(() => ({}));
          throw Error(err?.error?.message || 'Error al enviar por WhatsApp');
        }
        // guardar en DB si hay conversacion_id
        if (p.conversacion_id) {
          await sql`INSERT INTO wa_mensajes (conversacion_id, direccion, tipo, contenido)
                    VALUES (${p.conversacion_id}, 'saliente', 'text', ${p.mensaje})`;
          await sql`UPDATE wa_conversaciones SET ultimo_msg=now() WHERE id=${p.conversacion_id}`;
        }
        data = { enviado: true };
        break;
      }

      default:
        throw Error('Acción no disponible: ' + p.action);
    }

    res.status(200).json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'Error inesperado' });
  }
}
