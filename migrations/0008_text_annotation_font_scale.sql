UPDATE annotation_objects
SET payload_json = json_set(payload_json, '$.fontScale', 0.024)
WHERE deleted = 0
  AND json_extract(payload_json, '$.kind') = 'text'
  AND json_extract(payload_json, '$.fontScale') IS NULL;

DELETE FROM annotation_sync_operations
WHERE payload_json IS NOT NULL
  AND status = 'processing'
  AND json_extract(payload_json, '$.kind') = 'text'
  AND json_extract(payload_json, '$.fontScale') IS NULL;
