-- ============================================================
-- WASACHAT — Schema completo
-- Correr en Neon: console.neon.tech → SQL Editor → pegar y ejecutar
-- ============================================================

-- ── CONFIG DEL NEGOCIO ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agenda_config (
  clave  TEXT PRIMARY KEY,
  valor  TEXT,
  nota   TEXT
);

INSERT INTO agenda_config (clave, valor, nota) VALUES
  ('negocio_nombre',            'Mi Negocio',              'Nombre que aparece en mensajes y en el sitio'),
  ('negocio_whatsapp',          '',                        'Número WhatsApp con código de país (ej: 5491112345678)'),
  ('negocio_direccion',         '',                        'Dirección física (opcional)'),
  ('zona_horaria',              'America/Argentina/Buenos_Aires', 'Zona horaria'),
  ('intervalo_turnos_minutos',  '30',                      'Cada cuántos minutos se ofrecen turnos'),
  ('anticipacion_minima_horas', '1',                       'Horas mínimas de anticipación para reservar'),
  ('dias_max_anticipacion',     '30',                      'Días hacia adelante disponibles para reservar'),
  ('moneda',                    '$',                       'Símbolo de moneda'),
  ('color_primario',            '#1B4332',                 'Color principal'),
  ('color_secundario',          '#B08947',                 'Color secundario'),
  ('color_acento',              '#E8DCC8',                 'Color de fondo/acento'),
  ('waha_url',                  'http://localhost:3000',   'URL base de tu servidor WAHA'),
  ('waha_api_key',              '',                        'API key de WAHA (si la configuraste)'),
  ('waha_session',              'default',                 'Nombre de la sesión en WAHA'),
  ('msg_bienvenida',
   '¡Hola {nombre}! 👋 Bienvenido/a a *{negocio}*.' || chr(10) || chr(10) ||
   '¿En qué puedo ayudarte?' || chr(10) || chr(10) ||
   '1️⃣ Reservar un turno' || chr(10) ||
   '2️⃣ Ver mis reservas' || chr(10) ||
   '3️⃣ Cancelar un turno' || chr(10) ||
   '4️⃣ Hablar con alguien',
   'Mensaje de bienvenida del chatbot'),
  ('msg_confirmacion',
   '✅ ¡Reserva confirmada!' || chr(10) || chr(10) ||
   '📋 *{servicio}*' || chr(10) ||
   '👤 {especialista}' || chr(10) ||
   '📅 {fecha}' || chr(10) ||
   '🕐 {hora}' || chr(10) ||
   '💰 {precio}' || chr(10) || chr(10) ||
   'Código: *{codigo}*' || chr(10) || chr(10) ||
   '¡Te esperamos en {negocio}! 🎉',
   'Mensaje enviado al confirmar la reserva'),
  ('msg_recordatorio',
   '⏰ *Recordatorio de turno*' || chr(10) || chr(10) ||
   'Mañana tenés:' || chr(10) ||
   '📋 *{servicio}*' || chr(10) ||
   '👤 {especialista}' || chr(10) ||
   '📅 {fecha} a las {hora}' || chr(10) || chr(10) ||
   'Cualquier consulta respondé este mensaje.',
   'Mensaje de recordatorio 24hs antes'),
  ('msg_cancelacion',
   '❌ Tu reserva *{codigo}* del {fecha} a las {hora} fue cancelada.' || chr(10) || chr(10) ||
   'Escribinos cuando quieras para reprogramar.',
   'Mensaje enviado al cancelar una reserva')
ON CONFLICT (clave) DO NOTHING;

-- ── ESPECIALISTAS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agenda_especialistas (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre    TEXT NOT NULL,
  foto_url  TEXT,
  color     TEXT DEFAULT '#1B4332',
  activo    BOOLEAN DEFAULT true,
  orden     INT DEFAULT 0,
  creado    TIMESTAMPTZ DEFAULT now()
);

-- ── SERVICIOS ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agenda_servicios (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre            TEXT NOT NULL,
  descripcion       TEXT,
  duracion_minutos  INT NOT NULL DEFAULT 30,
  precio            NUMERIC(10,2) DEFAULT 0,
  especialista_id   UUID REFERENCES agenda_especialistas(id) ON DELETE SET NULL,
  activo            BOOLEAN DEFAULT true,
  orden             INT DEFAULT 0,
  creado            TIMESTAMPTZ DEFAULT now()
);

-- ── HORARIOS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agenda_horarios (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  especialista_id  UUID NOT NULL REFERENCES agenda_especialistas(id) ON DELETE CASCADE,
  dia_semana       TEXT NOT NULL CHECK (dia_semana IN ('Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo')),
  hora_inicio      TIME NOT NULL,
  hora_fin         TIME NOT NULL,
  activo           BOOLEAN DEFAULT true
);

-- ── BLOQUEOS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agenda_bloqueos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  especialista_id  TEXT NOT NULL DEFAULT 'TODOS',
  fecha_inicio     DATE NOT NULL,
  fecha_fin        DATE NOT NULL,
  hora_inicio      TIME,
  hora_fin         TIME,
  motivo           TEXT,
  creado           TIMESTAMPTZ DEFAULT now()
);

-- ── RESERVAS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agenda_reservas (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo            TEXT UNIQUE NOT NULL,
  especialista_id   UUID REFERENCES agenda_especialistas(id) ON DELETE SET NULL,
  servicio_id       UUID REFERENCES agenda_servicios(id) ON DELETE SET NULL,
  fecha             DATE NOT NULL,
  hora_inicio       TIME NOT NULL,
  hora_fin          TIME NOT NULL,
  cliente_nombre    TEXT NOT NULL,
  cliente_telefono  TEXT NOT NULL,
  cliente_email     TEXT,
  estado            TEXT NOT NULL DEFAULT 'pendiente'
                    CHECK (estado IN ('pendiente','confirmada','completada','cancelada')),
  notas             TEXT,
  origen            TEXT DEFAULT 'web'
                    CHECK (origen IN ('web','whatsapp','admin')),
  creado            TIMESTAMPTZ DEFAULT now(),
  actualizado       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reservas_fecha       ON agenda_reservas(fecha);
CREATE INDEX IF NOT EXISTS idx_reservas_especialista ON agenda_reservas(especialista_id);
CREATE INDEX IF NOT EXISTS idx_reservas_telefono    ON agenda_reservas(cliente_telefono);
CREATE INDEX IF NOT EXISTS idx_reservas_estado      ON agenda_reservas(estado);

-- Auto-actualizar timestamp
CREATE OR REPLACE FUNCTION fn_set_actualizado()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.actualizado = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_reservas_actualizado ON agenda_reservas;
CREATE TRIGGER trg_reservas_actualizado
  BEFORE UPDATE ON agenda_reservas
  FOR EACH ROW EXECUTE FUNCTION fn_set_actualizado();

-- ── CRM: CONTACTOS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_contactos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telefono    TEXT UNIQUE NOT NULL,
  nombre      TEXT,
  email       TEXT,
  etiquetas   TEXT[] DEFAULT '{}',
  notas       TEXT,
  estado      TEXT DEFAULT 'nuevo'
              CHECK (estado IN ('nuevo','activo','recurrente','vip','inactivo')),
  creado      TIMESTAMPTZ DEFAULT now(),
  actualizado TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contactos_telefono ON wa_contactos(telefono);

-- ── CRM: CONVERSACIONES ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_conversaciones (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contacto_id   UUID NOT NULL REFERENCES wa_contactos(id) ON DELETE CASCADE,
  estado        TEXT DEFAULT 'bot'
                CHECK (estado IN ('bot','abierta','resuelta')),
  bot_estado    TEXT DEFAULT 'inicio',
  bot_contexto  JSONB DEFAULT '{}',
  ultimo_msg    TIMESTAMPTZ DEFAULT now(),
  creado        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conv_contacto   ON wa_conversaciones(contacto_id);
CREATE INDEX IF NOT EXISTS idx_conv_ultimo_msg ON wa_conversaciones(ultimo_msg DESC);

-- ── CRM: MENSAJES ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_mensajes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversacion_id  UUID NOT NULL REFERENCES wa_conversaciones(id) ON DELETE CASCADE,
  waha_id          TEXT,
  direccion        TEXT NOT NULL CHECK (direccion IN ('entrante','saliente')),
  tipo             TEXT DEFAULT 'texto',
  contenido        TEXT,
  creado           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mensajes_conv    ON wa_mensajes(conversacion_id);
CREATE INDEX IF NOT EXISTS idx_mensajes_waha_id ON wa_mensajes(waha_id);
