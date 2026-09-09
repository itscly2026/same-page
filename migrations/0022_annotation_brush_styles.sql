-- One-time conversion of stored content. New clients write explicit brush semantics.
-- Accepted operation hashes remain immutable; they are not rendering data.
UPDATE annotation_objects SET payload_json = json_set(payload_json,
  '$.brush', CASE WHEN json_extract(payload_json, '$.strokeWidth') = 0.018 THEN 'highlighter' ELSE 'pen' END,
  '$.pressureMode', 'uniform')
WHERE json_extract(payload_json, '$.kind') = 'ink'
  AND json_extract(payload_json, '$.brush') IS NULL;
