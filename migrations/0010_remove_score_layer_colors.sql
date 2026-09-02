ALTER TABLE user_score_layer_preferences
  DROP COLUMN color_override;

UPDATE choir_shared_layer_settings
SET default_color = '#7c3aed'
WHERE slot = 'S'
  AND default_color = '#c2415d';
