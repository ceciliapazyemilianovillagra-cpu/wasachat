import postgres from 'postgres';

export function db() {
  return postgres(process.env.DATABASE_URL, {
    ssl: 'require',
    prepare: false,
    max: 1,
    idle_timeout: 5,
  });
}

export async function getCfg(sql) {
  const rows = await sql`SELECT clave, valor FROM agenda_config`;
  const cfg = {};
  for (const r of rows) cfg[r.clave] = r.valor;
  return cfg;
}

export const row = a => a[0];

export const txt = (v, n) => {
  v = String(v ?? '').trim();
  if (!v) throw Error(n + ' es obligatorio');
  return v;
};

export function minutosDeTime(t) {
  const [h, m] = String(t ?? '0:0').split(':');
  return Number(h) * 60 + Number(m || 0);
}

export function timeDeMinutos(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

export function generarCodigo() {
  return 'RES-' + Date.now().toString(36).toUpperCase().slice(-6);
}

const DIAS  = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

export function diaSemana(fechaISO) {
  return DIAS[new Date(fechaISO + 'T12:00:00').getDay()];
}

export function fechaBonita(fechaISO) {
  const d = new Date(fechaISO + 'T12:00:00');
  return `${DIAS[d.getDay()].toLowerCase()} ${d.getDate()} de ${MESES[d.getMonth()]}`;
}

export function aplicarPlantilla(plantilla, vars) {
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v ?? ''), plantilla);
}

function restarIntervalo(bloque, bi, bf) {
  if (bf <= bloque.inicio || bi >= bloque.fin) return [bloque];
  const r = [];
  if (bi > bloque.inicio) r.push({ inicio: bloque.inicio, fin: Math.min(bi, bloque.fin) });
  if (bf < bloque.fin)   r.push({ inicio: Math.max(bf, bloque.inicio), fin: bloque.fin });
  return r;
}

export async function calcularSlots(sql, especialistaId, fecha, duracion, intervalo, anticMs) {
  const dia = diaSemana(fecha);
  const horarios = await sql`
    SELECT hora_inicio::text, hora_fin::text FROM agenda_horarios
    WHERE especialista_id = ${especialistaId} AND dia_semana = ${dia} AND activo`;
  if (!horarios.length) return [];

  let bloques = horarios.map(h => ({ inicio: minutosDeTime(h.hora_inicio), fin: minutosDeTime(h.hora_fin) }));

  const bloqueos = await sql`
    SELECT hora_inicio::text, hora_fin::text FROM agenda_bloqueos
    WHERE (especialista_id = ${especialistaId} OR especialista_id = 'TODOS')
      AND fecha_inicio <= ${fecha}::date AND fecha_fin >= ${fecha}::date`;
  for (const b of bloqueos) {
    if (!b.hora_inicio) { bloques = []; break; }
    bloques = bloques.flatMap(bl => restarIntervalo(bl, minutosDeTime(b.hora_inicio), minutosDeTime(b.hora_fin)));
  }
  if (!bloques.length) return [];

  const reservas = await sql`
    SELECT hora_inicio::text, hora_fin::text FROM agenda_reservas
    WHERE especialista_id = ${especialistaId} AND fecha = ${fecha}::date AND estado != 'cancelada'`;
  const ocupados = reservas.map(r => ({ inicio: minutosDeTime(r.hora_inicio), fin: minutosDeTime(r.hora_fin) }));

  const ahora = Date.now();
  const slots = [];
  for (const bl of bloques) {
    for (let t = bl.inicio; t + duracion <= bl.fin; t += intervalo) {
      if (ocupados.some(o => t < o.fin && (t + duracion) > o.inicio)) continue;
      if (anticMs > 0) {
        const [y, mo, d] = fecha.split('-');
        const momento = new Date(Number(y), Number(mo) - 1, Number(d), Math.floor(t / 60), t % 60);
        if (momento.getTime() - ahora < anticMs) continue;
      }
      slots.push(timeDeMinutos(t));
    }
  }
  return slots;
}

export async function proxFechas(sql, cfg, especialistaId, duracion, cantidad = 5) {
  const intervalo = Number(cfg.intervalo_turnos_minutos) || 30;
  const anticMs   = (Number(cfg.anticipacion_minima_horas) || 0) * 3600000;
  const maxDias   = Math.min(Number(cfg.dias_max_anticipacion) || 30, 60);
  const fechas = [];
  const hoy = new Date();
  for (let i = 0; i < maxDias && fechas.length < cantidad; i++) {
    const d = new Date(hoy); d.setDate(hoy.getDate() + i);
    const iso = d.toLocaleDateString('en-CA');
    const slots = await calcularSlots(sql, especialistaId, iso, duracion, intervalo, anticMs);
    if (slots.length) fechas.push(iso);
  }
  return fechas;
}
