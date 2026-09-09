-- Preserve previously round highlights; new highlighters default to a chisel nib.
UPDATE annotation_objects SET payload_json = json_set(payload_json, '$.nib', 'round')
WHERE json_extract(payload_json, '$.kind') = 'ink'
  AND json_extract(payload_json, '$.nib') IS NULL;
