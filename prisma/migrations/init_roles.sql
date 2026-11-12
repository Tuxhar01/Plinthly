-- Plinthly Stage 2 Phase 1: Database Roles and Privilege Scoping
-- Canonical Contract v2.0.11 Section 6.3

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plinthly_security_admin') THEN
        CREATE ROLE plinthly_security_admin NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tax_verifier_role') THEN
        CREATE ROLE tax_verifier_role NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'webhook_ingress_role') THEN
        CREATE ROLE webhook_ingress_role NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_orchestrator_role') THEN
        CREATE ROLE app_orchestrator_role NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_security_role') THEN
        CREATE ROLE admin_security_role NOLOGIN;
    END IF;
END $$;

-- Schema usage grants
GRANT USAGE ON SCHEMA public TO PUBLIC;

