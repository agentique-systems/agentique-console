-- Legacy specification-spine retirement. The requirement graph is the one
-- governing spine; before `spec_revisions` drops, (1) every spec document is
-- archived verbatim to `event_artifacts`, and (2) each OPEN pre-graph run
-- (its project has no requirement revisions) keeps its governing document:
-- the latest approved spec becomes the project's intent prose plus one
-- approved `intent` requirement revision, so the run stays governed and the
-- approval lineage (interaction id, origin, timestamps) survives.
INSERT INTO `event_artifacts` ("id", "workspace_id", "user_session_id", "agent_session_id", "media_type", "bytes", "content", "created_at")
	SELECT 'artifact_' || s."id", us."workspace_id", s."user_session_id", NULL,
		'text/markdown', length(CAST(s."document" AS BLOB)), s."document", s."created_at"
	FROM `spec_revisions` s
	JOIN `user_sessions` us ON us."id" = s."user_session_id";
--> statement-breakpoint
UPDATE `projects` SET "intent_document" = (
		SELECT s."document"
		FROM `spec_revisions` s
		JOIN `user_sessions` us ON us."id" = s."user_session_id"
		WHERE us."project_id" = `projects`."id" AND s."status" = 'approved' AND us."lifecycle" = 'open'
		ORDER BY s."revision" DESC, s."created_at" DESC, s."rowid" DESC LIMIT 1
	)
	WHERE ("intent_document" IS NULL OR "intent_document" = '')
		AND NOT EXISTS (SELECT 1 FROM `requirement_revisions` rr WHERE rr."project_id" = `projects`."id")
		AND EXISTS (
			SELECT 1 FROM `spec_revisions` s
			JOIN `user_sessions` us ON us."id" = s."user_session_id"
			WHERE us."project_id" = `projects`."id" AND s."status" = 'approved' AND us."lifecycle" = 'open'
		);
--> statement-breakpoint
INSERT INTO `requirement_revisions` ("id", "project_id", "user_session_id", "revision", "kind", "scope_id", "base_revision", "document", "graph", "change_note", "status", "origin", "interaction_id", "created_at", "approved_at")
	SELECT 'reqrev_' || s."id", us."project_id", s."user_session_id", 1, 'intent', NULL, 0,
		s."document",
		json_object('title', NULL, 'preamble', json_array(json_object('heading', '', 'body', s."document")), 'nodes', json_array()),
		'migrated from the legacy specification (spec rev ' || s."revision" || ')',
		'approved', s."origin", s."interaction_id", s."created_at", COALESCE(s."approved_at", s."created_at")
	FROM `spec_revisions` s
	JOIN `user_sessions` us ON us."id" = s."user_session_id"
	WHERE us."lifecycle" = 'open'
		AND NOT EXISTS (SELECT 1 FROM `requirement_revisions` rr WHERE rr."project_id" = us."project_id")
		AND s."rowid" = (
			SELECT s2."rowid" FROM `spec_revisions` s2
			JOIN `user_sessions` us2 ON us2."id" = s2."user_session_id"
			WHERE us2."project_id" = us."project_id" AND s2."status" = 'approved' AND us2."lifecycle" = 'open'
			ORDER BY s2."revision" DESC, s2."created_at" DESC, s2."rowid" DESC LIMIT 1
		);
--> statement-breakpoint
DROP TABLE `spec_revisions`;