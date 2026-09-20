import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentClient } from '@blade-ai/agent-sdk/browser';
import { CONTINUATION_PREFIX, REPORT_TITLE, SECURITY_SECTION, textOf } from './DemoProvider.mjs';

const TASK = "Analyze this project's dependency risks";
const STEER = 'Focus on security issues';
const CONTINUE = 'Continue the analysis';

/** A throwaway Node project with two unpinned ranges, no lockfile and a postinstall hook. */
export async function createSmokeFixture() {
  // mkdtemp(tmpdir()) crosses a symlink on macOS (/var/folders -> /private/var/folders).
  // Resolving it here keeps the fixture's own path real, independent of the sandbox's
  // own handling of a symlinked workDir.
  const base = await realpath(await mkdtemp(join(tmpdir(), 'blade-web-smoke-')));
  const root = join(base, 'workspace');
  const dataDir = join(base, 'data');
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'smoke-fixture',
        version: '0.0.1',
        private: true,
        scripts: { postinstall: 'node ./setup.js' },
        dependencies: { 'left-pad': '^1.3.0', 'is-odd': '*' },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, 'setup.js'), "console.log('setup');\n");
  return { root, dataDir, cleanup: () => rm(base, { recursive: true, force: true }) };
}

function hasReport(messages) {
  return (messages ?? []).some(
    (message) => message.role === 'assistant' && textOf(message.content).includes(REPORT_TITLE),
  );
}

export async function runSmoke({ baseUrl, startedAt, budgetMs, restart }) {
  const createClient = () =>
    new AgentClient({
      baseUrl: `${baseUrl}/v1/agent`,
      client: { name: 'blade-web-starter-smoke', version: '2.0.0' },
      headers: { authorization: 'Bearer local-demo' },
    });
  const controller = new AbortController();
  const { signal } = controller;
  const deadline = setTimeout(
    () => controller.abort(new Error('Two-minute Web smoke budget exceeded')),
    Math.max(1, budgetMs - (performance.now() - startedAt)),
  );
  let client = createClient();
  let session;
  let cursor = null;
  const toolNames = [];
  const approvals = [];

  const collect = async (requestId, onStream) => {
    let output = '';
    for await (const event of session.events({ after: cursor, signal })) {
      if (cursor && event.sequence <= cursor.sequence) {
        throw new Error('Event replay duplicated an already consumed event');
      }
      cursor = {
        protocolVersion: event.protocolVersion,
        sessionId: event.sessionId,
        sequence: event.sequence,
        eventId: event.eventId,
      };
      if (event.type === 'session.closed') throw new Error('Session closed before producing a result');
      if (event.type === 'permission.requested') {
        // Without an OS sandbox, Bash needs approval. The smoke approves for the session.
        try {
          await client.resolvePermission(
            session.sessionId,
            event.data.permissionRequestId,
            { approved: true, scope: 'session' },
            { signal },
          );
        } catch (error) {
          // A steer can cancel the tool call between the request being issued and this
          // resolving it, which cancels the permission request first: the same race
          // client.js tolerates (see isDefiniteRejection/PERMISSION_NOT_FOUND) by
          // treating it as already settled rather than a bug. Follow that same
          // reasoning instead of failing the smoke over an approval nobody needed
          // anymore. Anything else is a real failure.
          if (error?.protocolCode !== 'PERMISSION_NOT_FOUND') throw error;
          continue;
        }
        approvals.push(event.data.toolName);
        continue;
      }
      if (event.type !== 'session.stream' || event.requestId !== requestId) continue;
      const data = event.data;
      if (data.type === 'tool_use') toolNames.push(data.name);
      if (data.type === 'content') output += data.delta;
      if (data.type === 'error') throw new Error(data.message);
      await onStream?.(data);
      if (data.type === 'result') {
        if (data.subtype !== 'success') throw new Error(`Request failed: ${data.error ?? 'unknown error'}`);
        return output || data.content || '';
      }
    }
    signal.throwIfAborted();
    throw new Error('Session event stream ended before producing a result');
  };

  try {
    session = await client.createSession({ source: 'web-starter-smoke' }, { signal });
    const sessionId = session.sessionId;

    // Steps 5-8: the task runs Glob, Read and Bash; steering right after Bash starts
    // interrupts the script, which then runs Grep and reports with a security section.
    const first = await session.send(TASK, { signal });
    if (first.status !== 'started' || !first.requestId) {
      throw new Error(`Unexpected submission: ${JSON.stringify(first)}`);
    }
    let steer;
    const report = await collect(first.requestId, async (data) => {
      if (!steer && data.type === 'tool_use' && data.name === 'Bash') {
        steer = await session.send(STEER, { priority: 'now', signal });
        if (steer.status !== 'steered') {
          throw new Error(`Steering was not accepted: ${JSON.stringify(steer)}`);
        }
      }
    });
    const firstResultMs = Math.round((performance.now() - startedAt) * 100) / 100;
    for (const name of ['Glob', 'Read', 'Bash', 'Grep']) {
      if (!toolNames.includes(name)) {
        throw new Error(`Expected a ${name} tool call; saw ${toolNames.join(', ') || 'none'}`);
      }
    }
    if (!steer) throw new Error('The script never reached Bash, so steering was not exercised');
    // Assert the positive: the npm line must read like a real npm ls summary
    // (see DemoProvider's npmLsSummary), not merely avoid a couple of known-bad
    // substrings. Any other wording - "did not return JSON", "exited N without
    // JSON output", "could not complete: interrupted twice", "was not run" -
    // means the command never actually completed, and fails the gate.
    const npmLine = report.split('\n').find((line) => line.startsWith('- npm ls'));
    const REAL_NPM_RESULT = /^- npm ls(?: reported \d+ problem\(s\)|: the installed tree matches the manifest)/;
    if (!npmLine || !REAL_NPM_RESULT.test(npmLine)) {
      throw new Error(`Report's npm line is not a real npm result: ${npmLine ?? '(no npm ls line found)'}`);
    }
    if (!report.includes(REPORT_TITLE) || !report.includes(SECURITY_SECTION)) {
      throw new Error(`Report did not reflect steering:\n${report}`);
    }

    // Step 9: restart the server process' runtime, resume the same session, keep going.
    const before = await session.read({ signal });
    if (!hasReport(before.messages)) throw new Error('Report missing from history before restart');
    const messagesBefore = before.messages.length;

    await restart();
    client = createClient();
    session = await client.resumeSession(sessionId, { signal });
    const after = await session.read({ signal });
    if (!hasReport(after.messages) || after.messages.length !== messagesBefore) {
      throw new Error(
        `History was not restored after restart: ${messagesBefore} messages before, ${after.messages?.length ?? 0} after`,
      );
    }

    const continued = await session.send(CONTINUE, { signal });
    if (continued.status !== 'started' || !continued.requestId) {
      throw new Error(`Unexpected continuation submission: ${JSON.stringify(continued)}`);
    }
    const continuation = await collect(continued.requestId);
    if (!continuation.includes(CONTINUATION_PREFIX)) {
      throw new Error(`Continuation did not use the saved report:\n${continuation}`);
    }
    await session.close({ signal });
    session = undefined;
    return {
      firstResultMs,
      toolNames,
      steered: true,
      approvals,
      restoredMessages: messagesBefore,
      continuationRestored: true,
      report,
    };
  } finally {
    clearTimeout(deadline);
    controller.abort();
    await session?.close({ signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  }
}
