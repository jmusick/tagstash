-- Personal API keys are stored hash-only (issue #9). Drop the reversibly encrypted
-- copies of existing keys; their key_hash rows stay, but the plaintext can no longer
-- be redisplayed. The column is kept (nullable) so older Worker code still works.
UPDATE api_keys SET encrypted_key = NULL WHERE encrypted_key IS NOT NULL;
