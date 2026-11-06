ALTER TABLE plugin_nevysha_decision_log_fcdc2e599f.decisions ADD COLUMN comment_id uuid;

CREATE UNIQUE INDEX decisions_comment_id_idx
  ON plugin_nevysha_decision_log_fcdc2e599f.decisions (comment_id);
