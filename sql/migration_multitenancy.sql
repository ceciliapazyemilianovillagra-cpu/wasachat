-- ============================================================
-- WASACHAT — Migración multi-tenant
-- Ejecutar en Neon SQL Editor
-- ============================================================

-- 1. Tabla de negocios
CREATE TABLE IF NOT EXISTS negocios (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT UNIQUE NOT NULL,           -- ej: "peluqueria-marta"
  nombre          TEXT NOT NULL,
  descripcion     TEXT,
  logo_url        TEXT,
  whatsapp        TEXT NOT NULL,                  -- número con código país: 5491136053816
  whatsapp_nombre TEXT,                           -- nombre que aparece en WA
  owner_whatsapp  TEXT,                           -- número del dueño para notificaciones
  admin_clave     TEXT,                           -- clave de acceso al panel admin
  admin_token     UUID DEFAULT gen_random_uuid(), -- token de sesión (se regenera en cada login)
  activo          BOOLEAN DEFAULT true,
  pausado         BOOLEAN DEFAULT false,
  creado          TIMESTAMPTZ DEFAULT now(),
  actualizado     TIMESTAMPTZ DEFAULT now()
);

-- 2. Migrar negocio existente como primer registro
INSERT INTO negocios (slug, nombre, whatsapp, activo)
SELECT
  'default',
  COALESCE((SELECT valor FROM agenda_config WHERE clave = 'negocio_nombre'), 'Mi Negocio'),
  COALESCE((SELECT valor FROM agenda_config WHERE clave = 'negocio_whatsapp'), '')
WHERE NOT EXISTS (SELECT 1 FROM negocios WHERE slug = 'default');

-- 3. Agregar negocio_id a todas las tablas relevantes
ALTER TABLE agenda_especialistas
  ADD COLUMN IF NOT EXISTS negocio_id UUID REFERENCES negocios(id) ON DELETE CASCADE;

ALTER TABLE agenda_servicios
  ADD COLUMN IF NOT EXISTS negocio_id UUID REFERENCES negocios(id) ON DELETE CASCADE;

ALTER TABLE agenda_horarios
  ADD COLUMN IF NOT EXISTS negocio_id UUID REFERENCES negocios(id) ON DELETE CASCADE;

ALTER TABLE agenda_bloqueos
  ADD COLUMN IF NOT EXISTS negocio_id UUID REFERENCES negocios(id) ON DELETE CASCADE;

ALTER TABLE agenda_reservas
  ADD COLUMN IF NOT EXISTS negocio_id UUID REFERENCES negocios(id) ON DELETE CASCADE;

ALTER TABLE agenda_config
  ADD COLUMN IF NOT EXISTS negocio_id UUID REFERENCES negocios(id) ON DELETE CASCADE;

ALTER TABLE wa_conversaciones
  ADD COLUMN IF NOT EXISTS negocio_id UUID REFERENCES negocios(id) ON DELETE CASCADE;

-- 4. Asignar negocio_id = default a todos los registros existentes
UPDATE agenda_especialistas SET negocio_id = (SELECT id FROM negocios WHERE slug = 'default') WHERE negocio_id IS NULL;
UPDATE agenda_servicios      SET negocio_id = (SELECT id FROM negocios WHERE slug = 'default') WHERE negocio_id IS NULL;
UPDATE agenda_horarios       SET negocio_id = (SELECT id FROM negocios WHERE slug = 'default') WHERE negocio_id IS NULL;
UPDATE agenda_bloqueos       SET negocio_id = (SELECT id FROM negocios WHERE slug = 'default') WHERE negocio_id IS NULL;
UPDATE agenda_reservas       SET negocio_id = (SELECT id FROM negocios WHERE slug = 'default') WHERE negocio_id IS NULL;
UPDATE agenda_config         SET negocio_id = (SELECT id FROM negocios WHERE slug = 'default') WHERE negocio_id IS NULL;
UPDATE wa_conversaciones     SET negocio_id = (SELECT id FROM negocios WHERE slug = 'default') WHERE negocio_id IS NULL;

-- 5. Config de recordatorio (si no existe)
INSERT INTO agenda_config (clave, valor, nota) VALUES
  ('recordatorio_horas_antes', '24', 'Horas antes del turno para enviar recordatorio')
ON CONFLICT (clave) DO NOTHING;

-- 6. Agregar columnas a negocios si ya existe la tabla
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS admin_clave TEXT;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS admin_token UUID DEFAULT gen_random_uuid();

-- Campo recordatorio en reservas
ALTER TABLE agenda_reservas
  ADD COLUMN IF NOT EXISTS recordatorio_enviado BOOLEAN DEFAULT false;

-- 7. Índices útiles
CREATE INDEX IF NOT EXISTS idx_negocios_slug       ON negocios(slug);
CREATE INDEX IF NOT EXISTS idx_especialistas_neg   ON agenda_especialistas(negocio_id);
CREATE INDEX IF NOT EXISTS idx_reservas_neg        ON agenda_reservas(negocio_id);
CREATE INDEX IF NOT EXISTS idx_conv_neg            ON wa_conversaciones(negocio_id);
