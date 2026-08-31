ALTER TABLE choirs
  ADD COLUMN is_preview_entry INTEGER NOT NULL DEFAULT 0
  CHECK (is_preview_entry IN (0, 1));

CREATE UNIQUE INDEX choirs_preview_entry_uidx
  ON choirs(is_preview_entry)
  WHERE is_preview_entry = 1;

CREATE TRIGGER choirs_preview_entry_requires_open_insert
BEFORE INSERT ON choirs
WHEN NEW.is_preview_entry = 1 AND NEW.guest_admission_mode != 'open'
BEGIN
  SELECT RAISE(ABORT, 'preview entry choir must use open guest admission');
END;

CREATE TRIGGER choirs_preview_entry_requires_open_update
BEFORE UPDATE OF is_preview_entry, guest_admission_mode ON choirs
WHEN NEW.is_preview_entry = 1 AND NEW.guest_admission_mode != 'open'
BEGIN
  SELECT RAISE(ABORT, 'preview entry choir must use open guest admission');
END;
