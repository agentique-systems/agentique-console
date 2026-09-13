ALTER TABLE runs ADD COLUMN mode text CONSTRAINT runs_mode CHECK (mode IS NULL OR mode = 'conversation');
--> statement-breakpoint
CREATE UNIQUE INDEX runs_active_conversation_context ON runs(conversation_id) WHERE mode = 'conversation' AND status NOT IN ('completed', 'failed', 'cancelled');
--> statement-breakpoint
CREATE TRIGGER runs_mode_immutable BEFORE UPDATE OF mode ON runs WHEN NEW.mode IS NOT OLD.mode BEGIN SELECT RAISE(ABORT, 'Run mode is immutable'); END;
--> statement-breakpoint
CREATE TABLE conversation_receipts (
  conversation_id text NOT NULL REFERENCES conversations(id),
  request_id text NOT NULL,
  digest text NOT NULL,
  response text NOT NULL,
  PRIMARY KEY (conversation_id, request_id)
);
--> statement-breakpoint
CREATE TABLE conversation_dispatches (
  invocation_id text PRIMARY KEY NOT NULL REFERENCES invocations(id),
  work_run_id text REFERENCES runs(id),
  error text
);
--> statement-breakpoint
CREATE INDEX conversation_messages_invocation ON conversation_messages(invocation_id);
--> statement-breakpoint
CREATE TRIGGER conversation_receipts_no_update BEFORE UPDATE ON conversation_receipts BEGIN SELECT RAISE(ABORT, 'Conversation receipts are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER conversation_receipts_no_delete BEFORE DELETE ON conversation_receipts BEGIN SELECT RAISE(ABORT, 'Conversation receipts are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER conversation_dispatches_no_update BEFORE UPDATE ON conversation_dispatches BEGIN SELECT RAISE(ABORT, 'Conversation dispatches are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER conversation_dispatches_no_delete BEFORE DELETE ON conversation_dispatches BEGIN SELECT RAISE(ABORT, 'Conversation dispatches are immutable'); END;
--> statement-breakpoint
UPDATE schema_info SET version = 3 WHERE id = 1;
