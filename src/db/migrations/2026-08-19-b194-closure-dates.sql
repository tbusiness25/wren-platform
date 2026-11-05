-- b194 (2026-08-19) — non-bank-holiday closures for occupancy / register / ratio surfaces.
--
-- ladn.bank_holidays already carries the statutory England & Wales list (83 rows, including
-- 2026-08-31 "Summer bank holiday"), but it was read only by src/routes/rota.js. b194 makes
-- every occupancy, register and ratio surface treat a closed date as CLOSED — 0 children,
-- 0 staff required — via src/lib/closures.js.
--
-- This key is the OTHER half: the closures that are not bank holidays (INSET / training
-- days, the Christmas shutdown, an emergency closure). Same effect, same code path.
--
-- Accepted entry shapes, mixable in one array:
--     "2026-12-24"
--     { "date": "2026-12-24", "name": "Christmas Eve — closed" }
--     { "from": "2026-12-24", "to": "2027-01-02", "name": "Christmas shutdown" }
--
-- Additive and idempotent: seeds an EMPTY array so the key exists to edit, and never
-- overwrites a list someone has already put there.

INSERT INTO ladn.settings (key, value)
VALUES ('closure_dates', '[]')
ON CONFLICT (key) DO NOTHING;
