import pg from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { AgentProtocolError } from '@blade-ai/agent-sdk/protocol';

function toPendingSubmission(row) {
  return { sessionId: row.sessionId, requestId: row.requestId, input: row.input, value: { ...row.value, input: row.input } };
}

/**
 * Example-owned control records. SDK transcripts, events and fencing stay in RuntimeStore.
 *
 * Authority map — which fact lives where, and what may be rebuilt:
 *
 * | Fact | Authority | Here |
 * |------|-----------|------|
 * | Conversation transcript, stream events | Runtime Store | not stored; read through the Session |
 * | Route state, worker lease, fencing | `session_routes` / `execution_leases` | never copied |
 * | Accepted input | Session journal | `repository_submissions` records that the input was handed to a Worker; a row lost before enqueueing can be rebuilt from the journal |
 * | Workspace checkpoint | route metadata (`REPOSITORY_KEY`) | `repository_state.checkpointId` is a readable projection |
 * | Approval lifecycle | durable events | `repository_permissions` mirrors it for the approval API |
 * | Cancellation intent | nothing else records it | `repository_cancellations` is authoritative |
 * | Terminal result | durable events | `repository_outcomes` holds the copy that must still be published |
 *
 * The submission rows are an acceptance record, not a second authority: startup
 * reconciliation drains them, and when a row itself was lost it re-derives the
 * pending request from the Session journal. The outcome rows cannot be rebuilt
 * from anywhere, which is why they are recorded before the route settles.
 */
export class RepositoryState {
  constructor({ connectionString, schema }) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new TypeError('Invalid schema');
    this.pool = new pg.Pool({ connectionString, max: 4 });
    this.prefix = `"${schema}"`;
  }

  async initialize() {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.prefix}`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.prefix}.repository_state (
      session_id text PRIMARY KEY, value jsonb NOT NULL DEFAULT '{}'::jsonb
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.prefix}.repository_permissions (
      session_id text NOT NULL, permission_id text NOT NULL, request_id text NOT NULL,
      request jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', decision jsonb,
      PRIMARY KEY (session_id, permission_id)
    )`);
    // `cleanup` is separate from `status` on purpose: a finished route does not
    // prove the execution environment stopped, so cancellation is acknowledged only
    // when both facts hold.
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.prefix}.repository_cancellations (
      session_id text NOT NULL, request_id text NOT NULL, status text NOT NULL DEFAULT 'requested',
      cleanup text NOT NULL DEFAULT 'pending', cleanup_detail text,
      PRIMARY KEY (session_id, request_id)
    )`);
    // Older databases predate the cleanup columns.
    await this.pool.query(
      `ALTER TABLE ${this.prefix}.repository_cancellations
         ADD COLUMN IF NOT EXISTS cleanup text NOT NULL DEFAULT 'pending'`,
    );
    await this.pool.query(
      `ALTER TABLE ${this.prefix}.repository_cancellations
         ADD COLUMN IF NOT EXISTS cleanup_detail text`,
    );
    // A submission is recorded here before the route is enqueued and cleared only
    // after enqueueing commits. Anything still pending on startup was accepted but
    // never handed to a Worker, which no lease-based recovery scan would find.
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.prefix}.repository_submissions (
      session_id text NOT NULL, request_id text NOT NULL, input text NOT NULL,
      value jsonb NOT NULL, status text NOT NULL DEFAULT 'accepted',
      accepted_at timestamptz NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, request_id)
    )`);
    // The terminal result is recorded before the route settles, so a crash
    // between settling and publishing cannot lose the only copy of the outcome.
    // `attempt` binds the outcome to the route claim that produced it, so
    // reconciliation only republishes results for the attempt that actually
    // settled. A re-run of the same request overwrites the record until it is
    // published; once published it is immutable.
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.prefix}.repository_outcomes (
      session_id text NOT NULL, request_id text NOT NULL, event jsonb NOT NULL,
      attempt integer, superseded_at timestamptz,
      published_at timestamptz, recorded_at timestamptz NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, request_id)
    )`);
    // Older databases predate the attempt and superseded columns.
    await this.pool.query(
      `ALTER TABLE ${this.prefix}.repository_outcomes
         ADD COLUMN IF NOT EXISTS attempt integer`,
    );
    await this.pool.query(
      `ALTER TABLE ${this.prefix}.repository_outcomes
         ADD COLUMN IF NOT EXISTS superseded_at timestamptz`,
    );
  }

  async recordSubmissionAccepted({ sessionId, requestId, input, value }) {
    await this.pool.query(
      `INSERT INTO ${this.prefix}.repository_submissions (session_id, request_id, input, value)
       VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (session_id, request_id) DO NOTHING`,
      [sessionId, requestId, input, JSON.stringify(value)],
    );
  }

  async markSubmissionQueued(sessionId, requestId) {
    await this.pool.query(
      `UPDATE ${this.prefix}.repository_submissions SET status = 'queued'
       WHERE session_id = $1 AND request_id = $2`,
      [sessionId, requestId],
    );
  }

  /**
   * Submissions accepted but never confirmed as enqueued, oldest first. `value` is
   * the accepted submission record flattened with the input it carried, which is
   * the shape `bladeQueuedRequest` metadata expects.
   */
  async listPendingSubmissions() {
    const { rows } = await this.pool.query(
      `SELECT session_id AS "sessionId", request_id AS "requestId", input, value
       FROM ${this.prefix}.repository_submissions
       WHERE status = 'accepted' ORDER BY accepted_at`,
    );
    return rows.map(toPendingSubmission);
  }

  /**
   * The accepted-but-not-enqueued submission for one Session. A retry of the same
   * input must hand off this record instead of sending it again: the input is
   * already durable in the Session journal, so a second send would duplicate it.
   */
  async getPendingSubmission(sessionId) {
    const { rows } = await this.pool.query(
      `SELECT session_id AS "sessionId", request_id AS "requestId", input, value
       FROM ${this.prefix}.repository_submissions
       WHERE session_id = $1 AND status = 'accepted'
       ORDER BY accepted_at LIMIT 1`,
      [sessionId],
    );
    return rows[0] ? toPendingSubmission(rows[0]) : null;
  }

  async recordOutcomePending({ sessionId, requestId, event, attempt }) {
    await this.pool.query(
      `INSERT INTO ${this.prefix}.repository_outcomes (session_id, request_id, event, attempt)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (session_id, request_id) DO UPDATE
         SET event = EXCLUDED.event, attempt = EXCLUDED.attempt, recorded_at = NOW()
         WHERE ${this.prefix}.repository_outcomes.published_at IS NULL`,
      [sessionId, requestId, JSON.stringify(event), attempt ?? null],
    );
  }

  async markOutcomePublished(sessionId, requestId) {
    await this.pool.query(
      `UPDATE ${this.prefix}.repository_outcomes SET published_at = NOW()
       WHERE session_id = $1 AND request_id = $2`,
      [sessionId, requestId],
    );
  }

  /**
   * Resolve an outcome that can never be published: its route settled for a
   * different request, so the client has already moved past this result.
   */
  async markOutcomeSuperseded(sessionId, requestId) {
    await this.pool.query(
      `UPDATE ${this.prefix}.repository_outcomes SET superseded_at = NOW()
       WHERE session_id = $1 AND request_id = $2 AND published_at IS NULL`,
      [sessionId, requestId],
    );
  }

  /** Terminal results recorded but never confirmed as published, oldest first. */
  async listUnpublishedOutcomes() {
    const { rows } = await this.pool.query(
      `SELECT session_id AS "sessionId", request_id AS "requestId", event, attempt
       FROM ${this.prefix}.repository_outcomes
       WHERE published_at IS NULL AND superseded_at IS NULL ORDER BY recorded_at`,
    );
    return rows.map((row) => ({ ...row, attempt: row.attempt ?? null }));
  }

  async getUnpublishedOutcome(sessionId, requestId) {
    const { rows } = await this.pool.query(
      `SELECT session_id AS "sessionId", request_id AS "requestId", event, attempt
       FROM ${this.prefix}.repository_outcomes
       WHERE session_id = $1 AND request_id = $2 AND published_at IS NULL AND superseded_at IS NULL`,
      [sessionId, requestId],
    );
    const row = rows[0];
    return row ? { ...row, attempt: row.attempt ?? null } : null;
  }

  async get(sessionId) {
    const { rows } = await this.pool.query(
      `SELECT value FROM ${this.prefix}.repository_state WHERE session_id = $1`, [sessionId],
    );
    return rows[0]?.value ?? {};
  }

  async update(sessionId, patch) {
    const { rows } = await this.pool.query(
      `INSERT INTO ${this.prefix}.repository_state AS s (session_id, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (session_id) DO UPDATE SET value = s.value || EXCLUDED.value RETURNING value`,
      [sessionId, JSON.stringify(patch)],
    );
    return rows[0].value;
  }

  async requestPermission({ sessionId, requestId, permissionRequestId, request }) {
    await this.pool.query(
      `INSERT INTO ${this.prefix}.repository_permissions (session_id, permission_id, request_id, request)
       VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING`,
      [sessionId, permissionRequestId, requestId, JSON.stringify(request)],
    );
    const record = await this.getPermission(sessionId, permissionRequestId);
    if (record.requestId !== requestId || record.request.toolName !== request.toolName
        || !isDeepStrictEqual(record.request.input, request.input)) {
      throw new Error('Permission ID cannot be reused for another operation');
    }
    return record;
  }

  async getPermission(sessionId, permissionRequestId) {
    const { rows } = await this.pool.query(
      `SELECT session_id AS "sessionId", permission_id AS "permissionRequestId", request_id AS "requestId",
       request, status, decision FROM ${this.prefix}.repository_permissions
       WHERE session_id = $1 AND permission_id = $2`, [sessionId, permissionRequestId],
    );
    return rows[0] ?? null;
  }

  async resolvePermission(sessionId, requestId, permissionRequestId, decision) {
    const { rowCount } = await this.pool.query(
      `UPDATE ${this.prefix}.repository_permissions SET status = 'resolved', decision = $4::jsonb
       WHERE session_id = $1 AND request_id = $2 AND permission_id = $3 AND status = 'pending'`,
      [sessionId, requestId, permissionRequestId, JSON.stringify(decision)],
    );
    if (!rowCount) {
      throw new AgentProtocolError('PERMISSION_NOT_FOUND', 'This permission is no longer pending', 404);
    }
  }

  async retirePermissions(sessionId, requestId) {
    await this.pool.query(
      `UPDATE ${this.prefix}.repository_permissions SET status = 'retired'
       WHERE session_id = $1 AND request_id = $2 AND status = 'pending'`, [sessionId, requestId],
    );
  }

  async requestCancel(sessionId, requestId) {
    await this.pool.query(
      `INSERT INTO ${this.prefix}.repository_cancellations (session_id, request_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`, [sessionId, requestId],
    );
    return this.getCancellation(sessionId, requestId);
  }

  async getCancellation(sessionId, requestId) {
    const { rows } = await this.pool.query(
      `SELECT status, cleanup, cleanup_detail AS "cleanupDetail"
       FROM ${this.prefix}.repository_cancellations WHERE session_id = $1 AND request_id = $2`,
      [sessionId, requestId],
    );
    return rows[0] ?? null;
  }

  /**
   * Record whether the execution environment actually stopped. Kept apart from the
   * cancellation's own status so a finished route cannot stand in for it.
   */
  async recordCancellationCleanup(sessionId, requestId, { succeeded, detail }) {
    await this.pool.query(
      `UPDATE ${this.prefix}.repository_cancellations
         SET cleanup = $3, cleanup_detail = $4
       WHERE session_id = $1 AND request_id = $2`,
      [sessionId, requestId, succeeded ? 'stopped' : 'failed', detail ?? null],
    );
  }

  async isCancelled(sessionId, requestId) {
    return Boolean(await this.getCancellation(sessionId, requestId));
  }

  async markCancelled(sessionId, requestId) {
    await this.pool.query(
      `UPDATE ${this.prefix}.repository_cancellations SET status = 'completed'
       WHERE session_id = $1 AND request_id = $2`, [sessionId, requestId],
    );
  }

  async close() { await this.pool.end(); }}
