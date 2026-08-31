UPDATE choirs
SET name = replace(name, '合唱团', '云盘')
WHERE instr(name, '合唱团') > 0;

UPDATE choirs
SET name = '公开体验云盘'
WHERE is_preview_entry = 1;
