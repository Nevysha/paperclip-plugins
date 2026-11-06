CREATE TABLE plugin_nevysha_decision_log_fcdc2e599f.decisions (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  author_type text NOT NULL CHECK (author_type IN ('agent', 'user')),
  author_agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  author_user_id text,
  run_id uuid,
  issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('answered_from_source', 'judgment_call', 'auto_approved_task')),
  question text NOT NULL,
  answer text NOT NULL,
  reasoning text NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_status text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'reviewed', 'overturned')),
  review_note text,
  reviewed_at timestamptz,
  reviewed_by text
);

CREATE INDEX decisions_company_created_idx
  ON plugin_nevysha_decision_log_fcdc2e599f.decisions (company_id, created_at DESC);
