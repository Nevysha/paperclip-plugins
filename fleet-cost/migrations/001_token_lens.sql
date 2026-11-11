-- Token Lens: summaries posted by collector/collect.mjs, which reads what plugins can't
-- (run events and the git history). Rows are re-posted whole, so ingest replaces them.

CREATE TABLE plugin_nevysha_fleet_cost_231f640c82.run_stats (
  run_id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  tool_calls integer NOT NULL,
  requests integer NOT NULL,
  first_context integer NOT NULL,
  max_context integer NOT NULL,
  start_tokens bigint NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_nevysha_fleet_cost_231f640c82.run_tools (
  run_id uuid NOT NULL,
  company_id uuid NOT NULL,
  category text NOT NULL,
  calls integer NOT NULL,
  step_tokens bigint NOT NULL,
  result_tokens bigint NOT NULL,
  output_bytes bigint NOT NULL,
  duration_ms bigint NOT NULL,
  PRIMARY KEY (run_id, category)
);

CREATE INDEX run_tools_company_idx ON plugin_nevysha_fleet_cost_231f640c82.run_tools (company_id);

CREATE TABLE plugin_nevysha_fleet_cost_231f640c82.commits (
  sha text PRIMARY KEY,
  company_id uuid NOT NULL,
  repo text NOT NULL,
  pr_number integer NOT NULL,
  pr_title text NOT NULL,
  pr_merged_at timestamptz,
  authored_at timestamptz,
  subject text NOT NULL,
  run_id uuid,
  match_method text NOT NULL CHECK (match_method IN ('hash', 'subject', 'none')),
  code_added integer NOT NULL,
  code_deleted integer NOT NULL,
  doc_added integer NOT NULL,
  doc_deleted integer NOT NULL,
  code_files integer NOT NULL,
  doc_files integer NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX commits_company_idx ON plugin_nevysha_fleet_cost_231f640c82.commits (company_id, pr_merged_at);
