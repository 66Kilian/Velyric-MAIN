ALTER TABLE app.balance_entries ADD CONSTRAINT balance_entries_kind_check CHECK (kind IN ('ADJUSTMENT', 'CREDIT', 'DEBIT', 'GOODWILL', 'REFUND')) NOT VALID;
ALTER TABLE app.balance_entries VALIDATE CONSTRAINT balance_entries_kind_check;
