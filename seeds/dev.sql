-- Development seed data.
--
-- IMPORTANT: the coordinates and the landmark list below are plausible
-- placeholders, not surveyed data. Walk the town with the nonprofit and replace
-- them before any real pilot — the gazetteer is the part locals will judge, and
-- a wrong alias ("la terminal" vs "la parada") makes the bot feel broken.
--
-- Zone lists are capped at 10 rows by WhatsApp, and landmark lists reserve one
-- row for "Otro lugar…", so keep each zone at 9 landmarks or fewer. Names are
-- capped at 24 characters (WA_MAX_ROW_TITLE): longer ones are trimmed with an
-- ellipsis before they are sent, so write the short form you want read and put
-- the long wording in the aliases, where the free-text search uses it.
--
-- A landmark's coordinates must snap to the zone it is declared in — zoneForPoint
-- picks the nearest zone centroid, and a pin that lands elsewhere means a hail
-- scored against a different part of town than the pin implies. A test asserts
-- this over the whole gazetteer, so a survey that moves a pin will hear about it.
--
-- OPEN QUESTION FOR THE SURVEY — Frontera El Florido. The Guatemalan border is
-- ~11 km down the road, but it is declared in 'salida_florido', the zone whose
-- centroid is the edge of town, so the matrix calls it 6 minutes from the Parque
-- Central. Its pin below had to be pulled back to the edge of town to satisfy
-- the rule above, which is the tell that the zone itself is wrong: one zone
-- cannot honestly hold both "the road out of town" and "a border 11 km down it".
-- Deciding that needs people who know the town — whether the border becomes its
-- own zone, or trips out there stop being routed through this matrix at all.

DELETE FROM dev_outbox;
DELETE FROM events;
DELETE FROM status_events;
DELETE FROM sessions;
DELETE FROM trips;
DELETE FROM drivers;
DELETE FROM zone_times;
DELETE FROM landmarks;
DELETE FROM zones;

INSERT INTO zones (id, name, sort_order, lat, lng) VALUES
  ('centro',          'Centro',                    1, 14.8397, -89.1531),
  ('ruinas',          'Las Ruinas',                2, 14.8400, -89.1417),
  ('barrio_arriba',   'Barrio arriba',             3, 14.8425, -89.1545),
  ('barrio_abajo',    'Barrio abajo',              4, 14.8370, -89.1548),
  ('salida_florido',  'Salida a El Florido',       5, 14.8412, -89.1610),
  ('salida_entrada',  'Salida a La Entrada',       6, 14.8378, -89.1455),
  ('aldeas',          'Aldeas / afueras',          7, 14.8500, -89.1700);

INSERT INTO landmarks (id, zone_id, name, aliases, lat, lng, sort_order) VALUES
  -- Centro
  ('parque_central', 'centro', 'Parque Central',        'parque,plaza,parque central,el parque', 14.8397, -89.1531, 1),
  ('mercado',        'centro', 'Mercado',               'mercado,el mercado,mercado municipal',  14.8393, -89.1538, 2),
  ('terminal',       'centro', 'Terminal de buses',     'terminal,buses,la terminal,parada',     14.8389, -89.1543, 3),
  ('hotel_marina',   'centro', 'Hotel Marina Copán',    'marina,hotel marina',                   14.8399, -89.1528, 4),
  ('iglesia',        'centro', 'Iglesia',               'iglesia,la iglesia,catedral,templo',    14.8396, -89.1533, 5),
  ('banco',          'centro', 'Bancos / Municipalidad','banco,bancos,municipalidad,alcaldia',   14.8395, -89.1536, 6),

  -- Las Ruinas
  ('parque_arq',     'ruinas', 'Parque Arqueológico',   'ruinas,las ruinas,parque arqueologico,sitio', 14.8400, -89.1417, 1),
  ('museo',          'ruinas', 'Museo de Escultura',    'museo,escultura',                        14.8402, -89.1421, 2),
  ('macaw_mountain', 'ruinas', 'Macaw Mountain',        'macaw,guacamayas,montana de guacamayas', 14.8430, -89.1445, 3),

  -- Barrio arriba
  -- 'Hospital' and not 'Hospital / Centro de salud': the long form is 26 characters,
  -- two over the row-title cap, and the aliases carry the other wordings anyway.
  ('hospital',       'barrio_arriba', 'Hospital',       'hospital,centro de salud,clinica,salud', 14.8428, -89.1549, 1),
  ('escuela_arriba', 'barrio_arriba', 'Escuela',        'escuela,colegio,kinder',                 14.8430, -89.1541, 2),
  ('mirador',        'barrio_arriba', 'El Mirador',     'mirador,el mirador',                     14.8438, -89.1552, 3),

  -- Barrio abajo
  ('estadio',        'barrio_abajo', 'Estadio',         'estadio,cancha,campo',                   14.8365, -89.1552, 1),
  ('cementerio',     'barrio_abajo', 'Cementerio',      'cementerio,camposanto',                  14.8358, -89.1544, 2),
  ('rio',            'barrio_abajo', 'El río',          'rio,el rio,puente,quebrada',             14.8372, -89.1560, 3),

  -- Salida a El Florido
  ('gasolinera',     'salida_florido', 'Gasolinera',    'gasolinera,bomba,gasolina',              14.8408, -89.1595, 1),
  -- Pin pulled back to the edge of town, not the border itself — see the open
  -- question in the header before treating this coordinate as surveyed.
  ('frontera',       'salida_florido', 'Frontera El Florido', 'frontera,el florido,guatemala,aduana', 14.8425, -89.1650, 2),

  -- Salida a La Entrada
  ('aeropuerto',     'salida_entrada', 'Aeródromo',     'aeropuerto,aerodromo,pista',             14.8370, -89.1440, 1),
  ('salida_sps',     'salida_entrada', 'Carretera a La Entrada', 'la entrada,san pedro,carretera,sps', 14.8355, -89.1470, 2),

  -- Aldeas
  ('sesesmil',       'aldeas', 'Sesesmil',              'sesesmil,sesemil',                       14.8700, -89.1600, 1),
  ('el_jaral',       'aldeas', 'El Jaral',              'jaral,el jaral',                         14.8600, -89.1800, 2),
  ('agua_caliente',  'aldeas', 'Agua Caliente',         'agua caliente,aguas calientes,termales', 14.8900, -89.1500, 3);

-- Hand-seeded travel times in minutes, tuktuk pace. Symmetric to start;
-- observed trips will pull the two directions apart (uphill is slower).
-- Replace with timings from an afternoon of driving around.
INSERT INTO zone_times (from_zone, to_zone, minutes, samples) VALUES
  ('centro','centro',3,0),                  ('centro','ruinas',7,0),
  ('centro','barrio_arriba',5,0),           ('centro','barrio_abajo',5,0),
  ('centro','salida_florido',6,0),          ('centro','salida_entrada',6,0),
  ('centro','aldeas',18,0),

  ('ruinas','centro',7,0),                  ('ruinas','ruinas',3,0),
  ('ruinas','barrio_arriba',10,0),          ('ruinas','barrio_abajo',9,0),
  ('ruinas','salida_florido',12,0),         ('ruinas','salida_entrada',8,0),
  ('ruinas','aldeas',22,0),

  ('barrio_arriba','centro',4,0),           ('barrio_arriba','ruinas',10,0),
  ('barrio_arriba','barrio_arriba',3,0),    ('barrio_arriba','barrio_abajo',8,0),
  ('barrio_arriba','salida_florido',8,0),   ('barrio_arriba','salida_entrada',9,0),
  ('barrio_arriba','aldeas',18,0),

  ('barrio_abajo','centro',5,0),            ('barrio_abajo','ruinas',9,0),
  ('barrio_abajo','barrio_arriba',8,0),     ('barrio_abajo','barrio_abajo',3,0),
  ('barrio_abajo','salida_florido',9,0),    ('barrio_abajo','salida_entrada',7,0),
  ('barrio_abajo','aldeas',20,0),

  ('salida_florido','centro',6,0),          ('salida_florido','ruinas',12,0),
  ('salida_florido','barrio_arriba',8,0),   ('salida_florido','barrio_abajo',9,0),
  ('salida_florido','salida_florido',4,0),  ('salida_florido','salida_entrada',11,0),
  ('salida_florido','aldeas',20,0),

  ('salida_entrada','centro',6,0),          ('salida_entrada','ruinas',8,0),
  ('salida_entrada','barrio_arriba',9,0),   ('salida_entrada','barrio_abajo',7,0),
  ('salida_entrada','salida_florido',11,0), ('salida_entrada','salida_entrada',4,0),
  ('salida_entrada','aldeas',22,0),

  ('aldeas','centro',18,0),                 ('aldeas','ruinas',22,0),
  ('aldeas','barrio_arriba',18,0),          ('aldeas','barrio_abajo',20,0),
  ('aldeas','salida_florido',20,0),         ('aldeas','salida_entrada',22,0),
  ('aldeas','aldeas',10,0);

-- Test drivers. Phone numbers are Honduras format (504) but fake.
INSERT INTO drivers (phone, name, tuktuk_no, status, zone_id, projected_zone_id, available_at, idle_since, updated_at) VALUES
  ('50499990001', 'Don José',   '3',  'available', 'centro',        'centro',        0, 0, 0),
  ('50499990002', 'Marvin',     '7',  'available', 'barrio_arriba', 'barrio_arriba', 0, 0, 0),
  ('50499990003', 'Doña Rosa',  '11', 'available', 'ruinas',        'ruinas',        0, 0, 0),
  ('50499990004', 'Chepe',      '15', 'off',       'centro',        'centro',        0, 0, 0);
