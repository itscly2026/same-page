ALTER TABLE annotation_layers ADD COLUMN default_slot TEXT
  CHECK (default_slot IS NULL OR default_slot IN ('G', 'S', 'A', 'T', 'B'));

CREATE UNIQUE INDEX annotation_layers_default_slot_uidx
  ON annotation_layers(score_id, default_slot)
  WHERE default_slot IS NOT NULL;

CREATE TRIGGER annotation_layers_default_slot_insert_guard
BEFORE INSERT ON annotation_layers
WHEN NEW.default_slot IS NOT NULL AND NEW.kind != 'shared'
BEGIN
  SELECT RAISE(ABORT, 'annotation_default_slot_requires_shared_layer');
END;

CREATE TRIGGER annotation_layers_default_slot_update_guard
BEFORE UPDATE OF kind, default_slot ON annotation_layers
WHEN NEW.default_slot IS NOT NULL AND NEW.kind != 'shared'
BEGIN
  SELECT RAISE(ABORT, 'annotation_default_slot_requires_shared_layer');
END;

INSERT INTO annotation_layers
  (id, choir_id, score_id, kind, owner_user_id, default_slot, name,
   sort_order, default_color, created_by_membership_id, created_at, updated_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-8' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  scores.choir_id,
  scores.id,
  'shared',
  NULL,
  slots.slot,
  slots.slot,
  slots.sort_order,
  slots.default_color,
  NULL,
  scores.created_at,
  scores.created_at
FROM scores
CROSS JOIN (
  SELECT 'G' AS slot, 0 AS sort_order, '#a12652' AS default_color
  UNION ALL SELECT 'S', 1, '#c2415d'
  UNION ALL SELECT 'A', 2, '#8a5a00'
  UNION ALL SELECT 'T', 3, '#0f766e'
  UNION ALL SELECT 'B', 4, '#3157a4'
) AS slots
WHERE NOT EXISTS (
  SELECT 1
  FROM annotation_layers
  WHERE annotation_layers.score_id = scores.id
    AND annotation_layers.default_slot = slots.slot
);
