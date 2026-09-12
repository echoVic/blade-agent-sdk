import { AgentClient } from '@blade-ai/agent-sdk/browser';

const form = document.querySelector('#prompt-form');
const promptInput = document.querySelector('#prompt');
const transcript = document.querySelector('#transcript');
const status = document.querySelector('#status');
const notice = document.querySelector('#notice');
const sessionLabel = document.querySelector('#session-id');
const submit = document.querySelector('#submit');
const cancel = document.querySelector('#cancel');
const reconnect = document.querySelector('#reconnect');
const newSession = document.querySelector('#new-session');

if (!form || !promptInput || !transcript || !status || !notice || !sessionLabel
  || !submit || !cancel || !reconnect || !newSession) {
  throw new Error('Web Agent example markup is incomplete');
}

const client = new AgentClient({
  baseUrl: `${window.location.origin}/v1/agent`,
  client: { name: 'blade-golden-path', version: '1.0.0' },
  headers: { authorization: 'Bearer local-demo' },
});
const STORAGE_KEY = 'blade-web-session:v1';
const emptyState = () => ({
  version: 1,
  sessionId: null,
  createCommandId: null,
  cursor: null,
  messages: [],
  activeRequestId: null,
  activeMessageIndex: null,
  pendingSubmission: null,
  cancelCommandId: null,
  pendingTerminal: null,
  permissions: [],
  handledPermissionIds: [],
  retiredPermissionIds: [],
  toolActivity: [],
  lastStatus: 'Ready',
});

let state = emptyState();
let session;
let generation = 0;
let operationController;
let streamController;
let connecting = false;
let disconnected = false;
let unavailable = false;
let storageWarning = '';

function save() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    storageWarning = 'This browser could not save the conversation. Refresh recovery is unavailable.';
  }
}

function restore() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!saved) return;
    const nullableString = (value) => value === null || typeof value === 'string';
    if (saved.version !== 1 || !nullableString(saved.sessionId)
      || !nullableString(saved.createCommandId) || !nullableString(saved.activeRequestId)
      || !nullableString(saved.cancelCommandId) || typeof saved.lastStatus !== 'string'
      || !Array.isArray(saved.messages)
      || !saved.messages.every((message) => ['user', 'assistant'].includes(message.role)
        && typeof message.content === 'string')
      || (saved.cursor !== null && (!saved.cursor || saved.cursor.sessionId !== saved.sessionId
        || !Number.isSafeInteger(saved.cursor.sequence) || saved.cursor.sequence < 0
        || typeof saved.cursor.eventId !== 'string' || saved.cursor.protocolVersion !== 1))
      || (saved.activeMessageIndex !== null && (!Number.isInteger(saved.activeMessageIndex)
        || saved.messages[saved.activeMessageIndex]?.role !== 'assistant'))
      || (saved.pendingSubmission !== null && (!saved.pendingSubmission
        || typeof saved.pendingSubmission.commandId !== 'string'
        || typeof saved.pendingSubmission.input !== 'string'))
      || ((saved.activeRequestId || saved.pendingSubmission) && saved.activeMessageIndex === null)) {
      throw new Error('Invalid saved conversation');
    }
    state = { ...emptyState(), ...saved };
    if (!Array.isArray(state.permissions) || !Array.isArray(state.handledPermissionIds)
      || !Array.isArray(state.retiredPermissionIds) || !Array.isArray(state.toolActivity)
      || !state.handledPermissionIds.every((id) => typeof id === 'string')
      || !state.retiredPermissionIds.every((id) => typeof id === 'string')
      || !state.toolActivity.every((activity) => activity && typeof activity.id === 'string'
        && typeof activity.name === 'string' && typeof activity.status === 'string'
        && typeof activity.summary === 'string')
      || !state.permissions.every((permission) => typeof permission.permissionRequestId === 'string'
        && typeof permission.toolName === 'string' && typeof permission.requestId === 'string'
        && (!permission.decision || (typeof permission.decision.commandId === 'string'
          && typeof permission.decision.approved === 'boolean')))) {
      state = emptyState();
      throw new Error('Invalid saved approvals');
    }
  } catch {
    storageWarning = 'The saved conversation could not be restored. Send a message to start again.';
  }
}

function hasRequest() {
  return Boolean(state.activeRequestId || state.pendingSubmission);
}

function render(label = state.lastStatus, message = '') {
  status.textContent = label === 'Running' && state.permissions.length ? 'Waiting for approval' : label;
  notice.textContent = message || storageWarning;
  sessionLabel.textContent = state.sessionId ?? 'Not started';
  promptInput.disabled = connecting || hasRequest() || unavailable || disconnected || !navigator.onLine;
  submit.disabled = promptInput.disabled;
  cancel.disabled = connecting || !state.activeRequestId || Boolean(state.cancelCommandId)
    || disconnected || unavailable || !navigator.onLine;
  reconnect.hidden = !disconnected || unavailable;
  reconnect.disabled = connecting || !navigator.onLine;
  newSession.disabled = connecting || (hasRequest() && !unavailable);
  transcript.replaceChildren();
  const lastMessage = state.messages.at(-1);
  const toolAnswer = state.toolActivity.length && lastMessage?.role === 'assistant' ? lastMessage : null;
  const appendMessage = (message) => {
    const article = document.createElement('article');
    article.className = `message message-${message.role}`;
    const label = document.createElement('span');
    label.className = 'message-role';
    label.textContent = message.role;
    const text = document.createElement('p');
    text.textContent = message.content;
    article.append(label, text);
    transcript.append(article);
  };
  for (const message of state.messages) {
    if (message !== toolAnswer) appendMessage(message);
  }
  for (const activity of state.toolActivity) {
    const article = document.createElement('article');
    article.className = 'tool-card';
    const title = document.createElement('strong');
    title.textContent = `${activity.name} · ${activity.status}`;
    const detail = document.createElement('p');
    detail.textContent = activity.summary;
    article.append(title, detail);
    transcript.append(article);
  }
  if (toolAnswer?.content) appendMessage(toolAnswer);
  for (const permission of state.permissions) {
    const article = document.createElement('article');
    article.className = 'approval-card';
    const title = document.createElement('h3');
    title.textContent = permission.title || `Allow ${permission.toolName}?`;
    const tool = document.createElement('strong');
    tool.textContent = permission.toolName;
    const description = document.createElement('p');
    description.textContent = permission.message || 'This action needs your approval.';
    article.append(title, tool, description);
    for (const [label, values] of [
      ['Affected paths', permission.affectedPaths], ['Risks', permission.risks],
    ]) {
      if (Array.isArray(values) && values.length) {
        const details = document.createElement('p');
        details.textContent = `${label}: ${values.join(', ')}`;
        article.append(details);
      }
    }
    if (permission.input && Object.keys(permission.input).length) {
      const replacement = typeof permission.input.expected_content === 'string'
        && typeof permission.input.content === 'string';
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = replacement ? 'Proposed file change' : 'Tool input';
      details.open = replacement;
      details.append(summary);
      for (const [label, text] of replacement
        ? [['Before', permission.input.expected_content], ['After', permission.input.content]]
        : [['', JSON.stringify(permission.input, null, 2)]]) {
        if (label) {
          const caption = document.createElement('p');
          caption.textContent = label;
          details.append(caption);
        }
        const input = document.createElement('pre');
        input.textContent = text;
        details.append(input);
      }
      article.append(details);
    }
    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    for (const [label, approved] of [['Approve once', true], ['Deny', false]]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.setAttribute('aria-label', `${label}: ${permission.toolName}`);
      button.disabled = Boolean(permission.decision || state.cancelCommandId)
        || connecting || disconnected || unavailable || !navigator.onLine;
      button.addEventListener('click', () => {
        if (!button.disabled) void decidePermission(permission.permissionRequestId, approved);
      });
      actions.append(button);
    }
    article.append(actions);
    if (permission.decision) {
      const pending = document.createElement('p');
      pending.textContent = 'Confirming your decision…';
      article.append(pending);
    }
    transcript.append(article);
  }
  transcript.scrollTop = transcript.scrollHeight;
}

function clearPermissions() {
  for (const permission of state.permissions) {
    if (!state.retiredPermissionIds.includes(permission.permissionRequestId)) {
      state.retiredPermissionIds.push(permission.permissionRequestId);
    }
  }
  state.permissions = [];
}

function updateToolActivity(event) {
  if (!['tool_use', 'tool_progress', 'tool_result'].includes(event.type)) return;
  let activity = state.toolActivity.find((entry) => entry.id === event.id);
  if (!activity) {
    activity = { id: event.id, name: event.name, status: 'Running', summary: '' };
    state.toolActivity.push(activity);
  }
  if (event.type === 'tool_progress') {
    const { message, completed, total } = event.progress;
    const progress = Number.isFinite(completed) && Number.isFinite(total)
      ? `${completed}/${total}` : '';
    activity.summary = [message, progress].filter(Boolean).join(' · ').slice(0, 1000);
  }
  if (event.type === 'tool_result') {
    activity.status = event.isError ? 'Failed' : 'Completed';
    const summary = event.display?.summary ?? (typeof event.output === 'string'
      ? event.output : JSON.stringify(event.output ?? ''));
    activity.summary = summary.slice(0, 1000);
  }
}

function stopConnection() {
  generation += 1;
  operationController?.abort();
  streamController?.abort();
  connecting = false;
}

function finishRequest(label, message = '') {
  streamController?.abort();
  state.activeRequestId = null;
  state.activeMessageIndex = null;
  state.pendingSubmission = null;
  state.cancelCommandId = null;
  state.pendingTerminal = null;
  clearPermissions();
  for (const activity of state.toolActivity) {
    if (activity.status === 'Running') {
      activity.status = label === 'Cancelled' ? 'Cancelled' : 'Ended';
      activity.summary ||= 'No tool result was received for this attempt.';
    }
  }
  state.lastStatus = label;
  disconnected = false;
  save();
  render(label, message);
}

function failed(error) {
  const code = error?.protocolCode;
  if (['SESSION_NOT_FOUND', 'SESSION_CLOSED', 'STALE_CURSOR'].includes(code)) {
    clearPermissions();
    save();
    unavailable = true;
    disconnected = false;
    render('Session unavailable', code === 'STALE_CURSOR'
      ? 'This conversation can no longer be replayed. The saved text is kept below; start a new session to continue.'
      : 'This session is no longer available on the server. The saved text is kept below; start a new session to continue.');
    return;
  }
  disconnected = true;
  render('Disconnected', `${error instanceof Error ? error.message : String(error)}. Reconnect to continue the same request.`);
}

function isDefiniteRejection(error) {
  return Boolean(error?.protocolCode)
    && !['COMMAND_IN_PROGRESS', 'INTERNAL_ERROR'].includes(error.protocolCode);
}

async function readEvents(currentGeneration) {
  const controller = new AbortController();
  streamController = controller;
  try {
    for await (const event of session.events({ after: state.cursor, signal: controller.signal })) {
      if (currentGeneration !== generation || controller.signal.aborted) return;
      if (event.sessionId !== state.sessionId) continue;
      // Persist rendered text and cursor together, including ignored events.
      if (event.sequence <= (state.cursor?.sequence ?? 0)) continue;
      state.cursor = {
        protocolVersion: event.protocolVersion,
        sessionId: event.sessionId,
        sequence: event.sequence,
        eventId: event.eventId,
      };
      if (event.type === 'session.closed') {
        save();
        failed({ protocolCode: 'SESSION_CLOSED' });
        return;
      }
      if (event.type === 'permission.requested') {
        const id = event.data.permissionRequestId;
        if (state.activeRequestId && (!event.requestId || event.requestId === state.activeRequestId)
          && !state.handledPermissionIds.includes(id) && !state.retiredPermissionIds.includes(id)
          && !state.permissions.some((permission) => permission.permissionRequestId === id)) {
          state.permissions.push({
            permissionRequestId: id,
            toolName: event.data.toolName,
            title: event.data.title,
            message: event.data.message,
            input: event.data.input,
            affectedPaths: event.data.affectedPaths,
            risks: event.data.risks,
            requestId: state.activeRequestId,
            decision: null,
          });
        }
        save();
        render(state.cancelCommandId ? 'Cancelling' : 'Running');
        continue;
      }
      if (event.type !== 'session.stream' || event.requestId !== state.activeRequestId) {
        save();
        continue;
      }
      const output = state.messages[state.activeMessageIndex];
      updateToolActivity(event.data);
      if (event.data.type === 'content') output.content += event.data.delta;
      if (event.data.type === 'result') {
        if (!output.content && event.data.content) output.content = event.data.content;
        state.pendingTerminal = {
          status: event.data.subtype === 'success' ? 'Ready' : 'Failed',
          message: event.data.error ?? '',
        };
      }
      if (event.data.type === 'error') {
        state.pendingTerminal = { status: 'Failed', message: event.data.message };
      }
      if (state.pendingTerminal) clearPermissions();
      if (state.pendingTerminal && !state.cancelCommandId) {
        finishRequest(state.pendingTerminal.status, state.pendingTerminal.message);
        return;
      }
      save();
      render(state.cancelCommandId ? 'Cancelling' : 'Running');
    }
    if (!controller.signal.aborted && currentGeneration === generation && hasRequest()) {
      throw new Error('The connection ended before the request completed');
    }
  } catch (error) {
    if (!controller.signal.aborted && currentGeneration === generation) failed(error);
  }
}

async function confirmPermission(permission, currentGeneration, signal) {
  if (!state.permissions.includes(permission) || !permission.decision) return;
  try {
    await client.resolvePermission(state.sessionId, permission.permissionRequestId, {
      approved: permission.decision.approved,
      scope: 'once',
    }, { commandId: permission.decision.commandId, signal });
  } catch (error) {
    if (currentGeneration !== generation || !state.permissions.includes(permission)) return;
    if (!isDefiniteRejection(error)
      || ['SESSION_NOT_FOUND', 'SESSION_CLOSED'].includes(error.protocolCode)) throw error;
    permission.decision = null;
    if (error.protocolCode === 'PERMISSION_NOT_FOUND') {
      state.permissions = state.permissions.filter((entry) => entry !== permission);
    }
    save();
    render(state.cancelCommandId ? 'Cancelling' : 'Running', error.protocolCode === 'PERMISSION_NOT_FOUND'
      ? 'This approval expired or was already resolved. Waiting for the agent to continue.'
      : `Your decision was not accepted: ${error.message}`);
    return;
  }
  if (currentGeneration !== generation || !state.permissions.includes(permission)) return;
  state.handledPermissionIds.push(permission.permissionRequestId);
  state.permissions = state.permissions.filter((entry) => entry !== permission);
  save();
  render(state.cancelCommandId ? 'Cancelling' : 'Running');
}

async function decidePermission(id, approved) {
  const permission = state.permissions.find((entry) => entry.permissionRequestId === id);
  if (!permission || permission.decision || state.cancelCommandId || disconnected || unavailable) return;
  permission.decision = { approved, commandId: crypto.randomUUID() };
  save();
  render('Running');
  const currentGeneration = generation;
  try {
    await confirmPermission(permission, currentGeneration, operationController?.signal);
  } catch (error) {
    if (currentGeneration === generation) failed(error);
  }
}

async function confirmCancellation(currentGeneration, signal) {
  try {
    await session.abort({ commandId: state.cancelCommandId, signal });
  } catch (error) {
    if (currentGeneration !== generation) return;
    if (!isDefiniteRejection(error)) throw error;
    // A rejected command is cached by commandId. Keep the task running instead
    // of replaying that rejected cancellation forever (e.g. the Docker demo).
    state.cancelCommandId = null;
    const message = `Cancellation was not accepted: ${error.message}`;
    if (state.pendingTerminal) {
      finishRequest(state.pendingTerminal.status, message);
    } else {
      streamController?.abort();
      disconnected = false;
      save();
      render('Running', message);
      void readEvents(currentGeneration);
    }
    return;
  }
  if (currentGeneration !== generation) return;
  // The ACK confirms server-side cancellation; a result event is not guaranteed.
  finishRequest('Cancelled');
}

async function connect() {
  stopConnection();
  const currentGeneration = generation;
  const controller = new AbortController();
  operationController = controller;
  connecting = true;
  disconnected = false;
  unavailable = false;
  render(state.sessionId ? 'Reconnecting' : 'Starting');
  try {
    if (!session) {
      if (state.sessionId) {
        let resumed;
        try {
          resumed = await client.resumeSession(state.sessionId, { signal: controller.signal });
        } catch (error) {
          if (error?.protocolCode === 'SESSION_CONFLICT') {
            const snapshot = await client.readSession(state.sessionId, { signal: controller.signal });
            if (snapshot.session?.status === 'closed') {
              if (currentGeneration !== generation) return;
              connecting = false;
              failed({ protocolCode: 'SESSION_CLOSED' });
              return;
            }
          }
          throw error;
        }
        if (currentGeneration !== generation) return;
        session = resumed;
      } else if (state.pendingSubmission) {
        state.createCommandId ??= crypto.randomUUID();
        save();
        const created = await client.createSession({ source: 'web-golden-path' }, {
          commandId: state.createCommandId,
          signal: controller.signal,
        });
        if (currentGeneration !== generation) return;
        session = created;
        state.sessionId = session.sessionId;
        state.createCommandId = null;
        save();
      }
    }
    if (currentGeneration !== generation) return;
    if (state.pendingSubmission) {
      const submission = await session.send(state.pendingSubmission.input, {
        commandId: state.pendingSubmission.commandId,
        signal: controller.signal,
      });
      if (currentGeneration !== generation) return;
      if (!submission.requestId) throw new Error('The server did not identify the submitted request');
      state.activeRequestId = submission.requestId;
      state.pendingSubmission = null;
      state.lastStatus = 'Running';
      save();
    }
    connecting = false;
    if (state.cancelCommandId) {
      render('Cancelling');
      await confirmCancellation(currentGeneration, controller.signal);
    } else if (state.activeRequestId) {
      render('Running');
      void readEvents(currentGeneration);
      for (const permission of [...state.permissions]) {
        if (currentGeneration !== generation) return;
        if (permission.decision) await confirmPermission(permission, currentGeneration, controller.signal);
      }
    } else {
      render(state.lastStatus);
    }
  } catch (error) {
    if (currentGeneration !== generation) return;
    connecting = false;
    if (state.pendingSubmission && isDefiniteRejection(error)
      && !['SESSION_NOT_FOUND', 'SESSION_CLOSED', 'STALE_CURSOR'].includes(error.protocolCode)) {
      promptInput.value = state.pendingSubmission.input;
      state.createCommandId = null;
      finishRequest('Failed', `Message was not accepted: ${error.message}`);
      return;
    }
    failed(error);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = promptInput.value.trim();
  if (!input || submit.disabled) return;
  promptInput.value = '';
  state.messages.push({ role: 'user', content: input }, { role: 'assistant', content: '' });
  state.activeMessageIndex = state.messages.length - 1;
  state.toolActivity = [];
  state.pendingSubmission = { commandId: crypto.randomUUID(), input };
  save();
  void connect();
});

cancel.addEventListener('click', async () => {
  if (cancel.disabled) return;
  state.cancelCommandId = crypto.randomUUID();
  save();
  render('Cancelling');
  const currentGeneration = generation;
  try {
    await confirmCancellation(currentGeneration, operationController?.signal);
  } catch (error) {
    if (currentGeneration === generation) failed(error);
  }
});

reconnect.addEventListener('click', () => { void connect(); });
newSession.addEventListener('click', async () => {
  if (newSession.disabled) return;
  stopConnection();
  const previous = session;
  session = undefined;
  state = emptyState();
  unavailable = false;
  disconnected = false;
  save();
  render();
  promptInput.focus();
  // Release the finished Session; a restarted server may already have lost it.
  await previous?.close({ signal: AbortSignal.timeout(5000) }).catch(() => undefined);
});

window.addEventListener('offline', () => {
  stopConnection();
  disconnected = true;
  render('Offline', 'Waiting for a connection. Your current request is saved.');
});
window.addEventListener('online', () => { void connect(); });
window.addEventListener('pagehide', () => { save(); stopConnection(); });
window.addEventListener('pageshow', (event) => {
  if (event.persisted) void connect();
});

restore();
render();
if (state.sessionId || state.pendingSubmission) void connect();
