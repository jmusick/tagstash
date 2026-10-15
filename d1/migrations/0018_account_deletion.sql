-- Keep deletion retryable across Stripe timeouts and D1 failures. Authentication
-- refuses pending accounts, and checkout cannot attach a newly-created customer.
-- The admin delete route fails closed until this column is available.
ALTER TABLE users ADD COLUMN deletion_started_at DATETIME;
