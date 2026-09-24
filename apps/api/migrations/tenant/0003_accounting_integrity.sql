-- Accounting integrity, enforced by the database so no application bug can break it:
--  1. A journal entry can only become 'posted' if it has >= 2 lines, a positive total and
--     debits equal to credits.
--  2. Posted and reversed entries are immutable. The only permitted change is
--     posted -> reversed (recording the reversing entry); they can never be deleted.
--  3. Lines of posted/reversed entries can't be inserted, changed or deleted.

CREATE OR REPLACE FUNCTION daliz_journal_entry_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total_debit numeric(20,4);
  total_credit numeric(20,4);
  line_count integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('posted', 'reversed') THEN
      RAISE EXCEPTION 'posted journal entry % cannot be deleted', OLD.number USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('posted', 'reversed') THEN
    IF OLD.status = 'posted' AND NEW.status = 'reversed'
       AND NEW.reversed_by_id IS NOT NULL
       AND NEW.number IS NOT DISTINCT FROM OLD.number
       AND NEW.entry_date = OLD.entry_date
       AND NEW.total_amount = OLD.total_amount
       AND NEW.description = OLD.description
       AND NEW.posted_at IS NOT DISTINCT FROM OLD.posted_at THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'posted journal entry % is immutable; reverse it instead', OLD.number USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'posted' THEN
    SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
      INTO total_debit, total_credit, line_count
      FROM journal_lines WHERE entry_id = NEW.id;
    IF line_count < 2 OR total_debit <> total_credit OR total_debit <= 0 THEN
      RAISE EXCEPTION 'journal entry is not balanced (debits %, credits %, lines %)', total_debit, total_credit, line_count
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.number IS NULL THEN
      RAISE EXCEPTION 'posted journal entry needs a number' USING ERRCODE = 'check_violation';
    END IF;
    NEW.total_amount := total_debit;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_guard
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION daliz_journal_entry_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION daliz_journal_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Entries are created unposted; posting happens by UPDATE so the balance check above runs.
  IF NEW.status IN ('posted', 'reversed') THEN
    RAISE EXCEPTION 'journal entries must be created unposted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_insert_guard
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION daliz_journal_insert_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION daliz_journal_line_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status FROM journal_entries
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.entry_id ELSE NEW.entry_id END;
  IF parent_status IN ('posted', 'reversed') THEN
    RAISE EXCEPTION 'lines of a posted journal entry are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.entry_id <> NEW.entry_id THEN
    SELECT status INTO parent_status FROM journal_entries WHERE id = OLD.entry_id;
    IF parent_status IN ('posted', 'reversed') THEN
      RAISE EXCEPTION 'lines of a posted journal entry are immutable' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION daliz_journal_line_guard();
