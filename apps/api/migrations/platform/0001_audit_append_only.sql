-- Audit logs are append-only: reject UPDATE, DELETE and TRUNCATE at the database level.
CREATE OR REPLACE FUNCTION daliz_reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit log is append-only (% on %)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER platform_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON platform_audit_logs
  FOR EACH ROW EXECUTE FUNCTION daliz_reject_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER platform_audit_logs_no_truncate
  BEFORE TRUNCATE ON platform_audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION daliz_reject_audit_mutation();
