-- Cambio de email confirmado por código enviado a la dirección NUEVA.
--
-- Idempotente a propósito: la base la administra otra persona y el deploy puede
-- sincronizarla con `db push` en vez de con la cadena de migraciones, así que
-- esto tiene que poder correr dos veces sin fallar.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'VerificationCodePurpose' AND e.enumlabel = 'EMAIL_CHANGE'
  ) THEN
    ALTER TYPE "VerificationCodePurpose" ADD VALUE 'EMAIL_CHANGE';
  END IF;
END $$;
