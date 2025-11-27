-- Initialize example rotation tracking in settings table
INSERT INTO settings (key, value)
VALUES ('example_rotation', '{"last_category_index": null, "last_updated": null}'::jsonb)
ON CONFLICT (key) DO NOTHING;
