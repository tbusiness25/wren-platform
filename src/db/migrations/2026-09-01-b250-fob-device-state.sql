-- ═══════════════════════════════════════════════════════════════════════════
-- b250 (2026-09-01) — NFC fob management: device state on ladn.staff_fobs
--
-- ADDITIVE ONLY. Every statement is IF NOT EXISTS / ON CONFLICT DO NOTHING and
-- safe to re-run. No DROP, no TRUNCATE, no DELETE. Applied to wren_dev by this
-- build; prod `wren` is a review step for Toby (see the b250 NOTES).
--
-- WHY THESE COLUMNS EXIST
-- b199 gave staff_fobs an is_active flag and nothing else, so "revoked in Wren"
-- and "no longer opens the door" were the same bit — and they are not the same
-- fact. The VTO is the enforcement point; Wren is the register. These columns
-- keep the two apart so the screen can be honest about which one is true:
--
--   device_state   where the card actually stands on the door station
--                    unverified      — nothing has been read back from the device
--                    on_device       — READ BACK from the VTO and present
--                    not_on_device   — read back and absent (drift)
--                    pending_removal — revoke asked for, device would not confirm it.
--                                      THE CARD STILL OPENS THE DOOR. is_active stays
--                                      true until the device confirms, so nothing in
--                                      Wren ever claims a live fob is dead.
--                    removed         — confirmed gone from the device
--   device_recno   the RecNo the VTO assigned. Stored for reference only — it is
--                  NOT stable across deletes, so every destructive call re-resolves
--                  by CardNo first (see dahua-client.findCard).
--   device_is_valid  the IsValid flag as the device reports it. On firmware
--                  4.511.10EX002.0.R this is ALWAYS false and cannot be set —
--                  see the 2026-09-01 re-probe note in src/lib/dahua-client.js.
--                  Recorded rather than acted on, so a firmware change shows up.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ladn.staff_fobs ADD COLUMN IF NOT EXISTS device_recno        INTEGER;
ALTER TABLE ladn.staff_fobs ADD COLUMN IF NOT EXISTS device_state        VARCHAR(24) DEFAULT 'unverified';
ALTER TABLE ladn.staff_fobs ADD COLUMN IF NOT EXISTS device_synced_at    TIMESTAMPTZ;
ALTER TABLE ladn.staff_fobs ADD COLUMN IF NOT EXISTS device_last_result  TEXT;
ALTER TABLE ladn.staff_fobs ADD COLUMN IF NOT EXISTS device_is_valid     BOOLEAN;
ALTER TABLE ladn.staff_fobs ADD COLUMN IF NOT EXISTS revoke_requested_at TIMESTAMPTZ;
ALTER TABLE ladn.staff_fobs ADD COLUMN IF NOT EXISTS revoke_requested_by INTEGER;
ALTER TABLE ladn.staff_fobs ADD COLUMN IF NOT EXISTS revoke_attempts     INTEGER DEFAULT 0;
ALTER TABLE ladn.staff_fobs ADD COLUMN IF NOT EXISTS revoke_last_error   TEXT;
ALTER TABLE ladn.staff_fobs ADD COLUMN IF NOT EXISTS issued_by           INTEGER;
ALTER TABLE ladn.staff_fobs ADD COLUMN IF NOT EXISTS replaced_by_fob_id  INTEGER;

-- Existing rows predate device verification and must not masquerade as verified.
UPDATE ladn.staff_fobs SET device_state = 'unverified' WHERE device_state IS NULL;

-- The pending-removal sweeper asks one question on a timer: "any fob still to be
-- pulled off the door?" A partial index keeps that a no-op when the answer is none.
CREATE INDEX IF NOT EXISTS idx_staff_fobs_pending_removal
  ON ladn.staff_fobs (revoke_requested_at)
  WHERE device_state = 'pending_removal';

-- ── Capability key (b237 matrix) ────────────────────────────────────────────
-- Deliberately in the `staff` category: a fob is a staff credential, and the
-- person who manages staff records is the person who issues door access.
-- NO role grants are seeded. With no row in role_capabilities the only people who
-- pass are manager / headteacher / Toby (id=1) — capabilities.js resolves those to
-- 'manage' — so the default is manager-only, exactly as the brief asks. Toby can
-- then grant the deputy 'view' (see the keyring) or 'manage' (issue and revoke)
-- from the Permissions screen without a code change.
INSERT INTO ladn.capabilities (key, display_name, category, description)
VALUES ('staff.access-fobs', 'Door fobs (issue / revoke)', 'staff',
        'Issue, replace and revoke NFC door fobs on the Dahua door station. ' ||
        '''view'' shows the keyring and the reconcile view; ''manage'' is required ' ||
        'to write to or remove a card from the door itself.')
ON CONFLICT (key) DO NOTHING;
