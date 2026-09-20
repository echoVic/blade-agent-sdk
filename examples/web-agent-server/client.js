import { AgentClient } from '@blade-ai/agent-sdk/browser';

const query = (selector) => document.querySelector(selector);
const form = query('#prompt-form');
const promptInput = query('#prompt');
const timeline = query('#timeline');
const status = query('#status');
const notice = query('#notice');
const hint = query('#hint');
const sessionLabel = query('#session-id');
const submit = query('#submit');
const cancel = query('#cancel');
const reconnect = query('#reconnect');
const newSession = query('#new-session');

if (!form || !promptInput || !timeline || !status || !notice || !hint || !sessionLabel
  || !submit || !cancel || !reconnect || !newSession) {
  throw new Error('Web Agent starter markup is incomplete');
}

const client = new AgentClient({
  baseUrl: `${window.location.origin}/v1/agent`,
  client: { name: 'blade-web-starter', version: '2.0.0' },
  headers: { authorization: 'Bearer local-demo' },
});
const STORAGE_KEY = 'blade-web-session:v2';
const MAX_NODES = 200;
const OUTPUT_PREVIEW_LINES = 20;
const DEFAULT_PLACEHOLDER = "Ask the agent to analyze this project's dependency risks";
const emptyState = () => ({
  version: 2,
  sessionId: null,
  createCommandId: null,
  cursor: null,
  nodes: [],
  activeRequestId: null,
  pendingSubmission: null,
  cancelCommandId: null,
  pendingTerminal: null,
  permissions: [],
  handledPermissionIds: [],
  retiredPermissionIds: [],
  lastStatus: 'Idle',
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

// ---------- persistence ----------

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    storageWarning = 'This browser could not save the conversation; refresh recovery is unavailable.';
  }
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!saved) return;
    const optional = (value) => value === null || typeof value === 'string';
    if (saved.version !== 2 || !optional(saved.sessionId) || !optional(saved.activeRequestId)
      || !optional(saved.cancelCommandId) || !Array.isArray(saved.nodes)
      || !Array.isArray(saved.permissions) || !Array.isArray(saved.handledPermissionIds)
      || !Array.isArray(saved.retiredPermissionIds)
      || !saved.nodes.every((node) => node && typeof node.id === 'string' && typeof node.kind === 'string')) {
      throw new Error('Invalid saved conversation');
    }
    state = { ...emptyState(), ...saved };
  } catch {
    state = emptyState();
    storageWarning = 'The saved conversation could not be restored. Send a message to start again.';
  }
}

// ---------- timeline model ----------

function addNode(node) {
  const created = { id: crypto.randomUUID(), ...node };
  state.nodes.push(created);
  if (state.nodes.length > MAX_NODES) state.nodes.splice(0, state.nodes.length - MAX_NODES);
  return created;
}

function lastNode(predicate) {
  return state.nodes.findLast(predicate);
}

function findTool(toolId) {
  return lastNode((node) => node.kind === 'tool' && node.toolId === toolId);
}

function hasRequest() {
  return Boolean(state.activeRequestId || state.pendingSubmission);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((part) => part && part.type === 'text').map((part) => part.text).join('');
  }
  return '';
}

function summarizeArgs(input) {
  try {
    const text = typeof input === 'string' ? input : JSON.stringify(input ?? {});
    return text.length > 160 ? `${text.slice(0, 157)}…` : text;
  } catch {
    return '';
  }
}

function previewOutput(output) {
  let text;
  if (output && typeof output === 'object' && !Array.isArray(output) && 'stdout' in output) {
    text = [output.stdout, output.stderr].filter(Boolean).join('\n');
  } else {
    text = typeof output === 'string' ? output : JSON.stringify(output ?? '', null, 2);
  }
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
}

function applyStreamEvent(data) {
  const requestId = state.activeRequestId;
  switch (data.type) {
    case 'thinking': {
      let node = lastNode((entry) => entry.requestId === requestId);
      if (!node || node.kind !== 'thinking') node = addNode({ kind: 'thinking', requestId, text: '', open: false });
      node.text += data.delta;
      return;
    }
    case 'content': {
      let node = lastNode((entry) => entry.requestId === requestId);
      if (!node || node.kind !== 'assistant') node = addNode({ kind: 'assistant', requestId, text: '' });
      node.text += data.delta;
      return;
    }
    case 'tool_use':
      addNode({
        kind: 'tool',
        requestId,
        toolId: data.id,
        name: data.name,
        args: summarizeArgs(data.input),
        status: 'Running',
        summary: '',
        output: '',
        startedAt: Date.now(),
        endedAt: null,
        open: false,
      });
      return;
    case 'tool_progress': {
      const node = findTool(data.id);
      if (!node) return;
      const { message, completed, total } = data.progress ?? {};
      const progress = Number.isFinite(completed) && Number.isFinite(total) ? `${completed}/${total}` : '';
      node.summary = [message, progress].filter(Boolean).join(' · ').slice(0, 300);
      return;
    }
    case 'tool_result': {
      const node = findTool(data.id);
      if (!node) return;
      node.status = data.isError ? 'Failed' : 'Completed';
      node.endedAt = Date.now();
      node.summary = (data.display?.summary ?? '').slice(0, 300);
      node.output = previewOutput(data.output);
      return;
    }
    case 'input_applied': {
      const steer = lastNode((entry) => entry.kind === 'steer' && entry.inputId === data.inputId);
      if (steer) steer.status = 'applied';
      return;
    }
    case 'turn_interrupted':
      addNode({ kind: 'system', requestId, text: 'Interrupting the current step to apply your instruction' });
      return;
    case 'result':
      if (data.subtype === 'success' && data.content
        && !lastNode((entry) => entry.requestId === requestId && entry.kind === 'assistant')) {
        addNode({ kind: 'assistant', requestId, text: data.content });
      }
      state.pendingTerminal = { status: data.subtype === 'success' ? 'Idle' : 'Failed', message: data.error ?? '' };
      return;
    case 'error':
      addNode({ kind: 'error', requestId, text: data.message });
      state.pendingTerminal = { status: 'Failed', message: data.message };
      return;
    default:
      return;
  }
}

// ---------- rendering ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function duration(node) {
  if (!node.startedAt) return '';
  const ms = (node.endedAt ?? Date.now()) - node.startedAt;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const STEER_LABELS = {
  pending: 'Steering…',
  steered: 'Steered',
  queued: 'Queued for next turn',
  applied: 'Steering applied',
  started: 'Sent as a new turn',
  failed: 'Steering rejected',
};

function renderTool(node) {
  const article = el('article', 'node tool');
  article.dataset.status = node.status;
  const head = el('div', 'head');
  head.append(
    el('span', 'name', node.name),
    el('span', 'args', node.args),
    el('span', 'meta', [node.status, duration(node)].filter(Boolean).join(' · ')),
  );
  article.append(head);
  if (node.summary) article.append(el('div', 'meta', node.summary));
  if (node.output) {
    const lines = node.output.split('\n');
    const details = el('details');
    details.open = Boolean(node.open);
    details.append(
      el('summary', '', `Output (${lines.length} lines)`),
      el('pre', '', lines.slice(0, node.open ? lines.length : OUTPUT_PREVIEW_LINES).join('\n')),
    );
    details.addEventListener('toggle', () => {
      node.open = details.open;
      save();
      render();
    });
    article.append(details);
  }
  return article;
}

function renderNode(node) {
  switch (node.kind) {
    case 'user':
      return el('article', 'node user', node.text);
    case 'assistant':
      return el('article', 'node assistant', node.text);
    case 'system':
      return el('article', 'node system', node.text);
    case 'error':
      return el('article', 'node error', node.text);
    case 'steer':
      return el('article', 'node steer', `${STEER_LABELS[node.status] ?? node.status}: ${node.text}`);
    case 'thinking': {
      const details = el('details', 'node thinking');
      details.open = Boolean(node.open);
      details.append(el('summary', '', 'Thinking'), el('pre', '', node.text));
      details.addEventListener('toggle', () => {
        node.open = details.open;
        save();
      });
      return details;
    }
    case 'tool':
      return renderTool(node);
    default:
      return el('article', 'node system', node.text ?? '');
  }
}

function renderApproval(permission) {
  const article = el('article', 'node approval');
  article.append(
    el('h3', '', permission.title || `Allow ${permission.toolName}?`),
    el('p', 'meta', permission.toolName),
    el('p', '', permission.message || 'This action needs your approval.'),
  );
  for (const [label, values] of [['Affected paths', permission.affectedPaths], ['Risks', permission.risks]]) {
    if (Array.isArray(values) && values.length) article.append(el('p', 'meta', `${label}: ${values.join(', ')}`));
  }
  if (permission.input && Object.keys(permission.input).length) {
    const replacement = typeof permission.input.expected_content === 'string'
      && typeof permission.input.content === 'string';
    const details = el('details');
    details.open = replacement;
    details.append(el('summary', '', replacement ? 'Proposed file change' : 'Tool input'));
    for (const [label, text] of replacement
      ? [['Before', permission.input.expected_content], ['After', permission.input.content]]
      : [['', JSON.stringify(permission.input, null, 2)]]) {
      if (label) details.append(el('p', 'meta', label));
      details.append(el('pre', '', text));
    }
    article.append(details);
  }
  const actions = el('div', 'actions');
  for (const [label, approved, scope] of [
    ['Approve once', true, 'once'],
    ['Approve for this session', true, 'session'],
    ['Deny', false, 'once'],
  ]) {
    const button = el('button', approved ? 'primary' : '', label);
    button.type = 'button';
    button.setAttribute('aria-label', `${label}: ${permission.toolName}`);
    button.disabled = Boolean(permission.decision || state.cancelCommandId)
      || connecting || disconnected || unavailable || !navigator.onLine;
    button.addEventListener('click', () => {
      if (!button.disabled) void decidePermission(permission.permissionRequestId, approved, scope);
    });
    actions.append(button);
  }
  article.append(actions);
  if (permission.decision) article.append(el('p', 'meta', 'Confirming your decision…'));
  return article;
}

function toneFor(label, waiting) {
  if (waiting) return 'wait';
  if (label === 'Working' || label === 'Cancelling' || label === 'Reconnecting' || label === 'Starting') return 'work';
  if (['Failed', 'Disconnected', 'Unavailable', 'Offline'].includes(label)) return 'bad';
  if (label === 'Idle' || label === 'Restored') return 'ok';
  return '';
}

function render(label = state.lastStatus, message = '') {
  const waiting = label === 'Working' && state.permissions.length > 0;
  status.textContent = waiting ? 'Waiting for approval' : label;
  status.dataset.tone = toneFor(label, waiting);
  notice.textContent = message || storageWarning;
  sessionLabel.textContent = state.sessionId ?? 'Not started';
  const offline = !navigator.onLine;
  const blocked = connecting || unavailable || disconnected || offline;
  const steering = hasRequest() && !blocked;
  promptInput.disabled = blocked;
  submit.disabled = blocked;
  promptInput.dataset.steering = String(steering);
  promptInput.placeholder = steering ? 'Agent is working, type to steer it' : DEFAULT_PLACEHOLDER;
  submit.textContent = steering ? 'Steer' : 'Send';
  hint.textContent = steering
    ? 'Enter inserts your instruction into the running task right away.'
    : 'Enter sends, Shift+Enter adds a line.';
  cancel.disabled = connecting || !state.activeRequestId || Boolean(state.cancelCommandId)
    || disconnected || unavailable || offline;
  reconnect.hidden = !disconnected || unavailable;
  reconnect.disabled = connecting || offline;
  newSession.disabled = connecting || (hasRequest() && !unavailable);
  const stick = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
  timeline.replaceChildren(...state.nodes.map(renderNode), ...state.permissions.map(renderApproval));
  if (stick) timeline.scrollTop = timeline.scrollHeight;
}

// ---------- request lifecycle ----------

function clearPermissions() {
  for (const permission of state.permissions) {
    if (!state.retiredPermissionIds.includes(permission.permissionRequestId)) {
      state.retiredPermissionIds.push(permission.permissionRequestId);
    }
  }
  state.permissions = [];
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
  state.pendingSubmission = null;
  state.cancelCommandId = null;
  state.pendingTerminal = null;
  clearPermissions();
  for (const node of state.nodes) {
    if (node.kind === 'tool' && node.status === 'Running') {
      node.status = label === 'Cancelled' ? 'Cancelled' : 'Ended';
      node.endedAt = Date.now();
      node.summary ||= 'No tool result was received for this attempt.';
    }
    if (node.kind === 'steer' && node.status === 'pending') node.status = 'failed';
  }
  state.lastStatus = label === 'Cancelled' || label === 'Idle' ? 'Idle' : label;
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
    render('Unavailable', code === 'STALE_CURSOR'
      ? 'This conversation can no longer be replayed. The saved timeline is kept; start a new session to continue.'
      : 'This session is no longer available on the server. The saved timeline is kept; start a new session to continue.');
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
        render(state.cancelCommandId ? 'Cancelling' : 'Working');
        continue;
      }
      if (event.type !== 'session.stream' || event.requestId !== state.activeRequestId) {
        save();
        continue;
      }
      applyStreamEvent(event.data);
      if (state.pendingTerminal) clearPermissions();
      if (state.pendingTerminal && !state.cancelCommandId) {
        finishRequest(state.pendingTerminal.status, state.pendingTerminal.message);
        return;
      }
      save();
      render(state.cancelCommandId ? 'Cancelling' : 'Working');
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
      scope: permission.decision.scope,
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
    render(state.cancelCommandId ? 'Cancelling' : 'Working', error.protocolCode === 'PERMISSION_NOT_FOUND'
      ? 'This approval expired or was already resolved. Waiting for the agent to continue.'
      : `Your decision was not accepted: ${error.message}`);
    return;
  }
  if (currentGeneration !== generation || !state.permissions.includes(permission)) return;
  state.handledPermissionIds.push(permission.permissionRequestId);
  state.permissions = state.permissions.filter((entry) => entry !== permission);
  save();
  render(state.cancelCommandId ? 'Cancelling' : 'Working');
}

async function decidePermission(id, approved, scope) {
  const permission = state.permissions.find((entry) => entry.permissionRequestId === id);
  if (!permission || permission.decision || state.cancelCommandId || disconnected || unavailable) return;
  permission.decision = { approved, scope, commandId: crypto.randomUUID() };
  save();
  render('Working');
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
    state.cancelCommandId = null;
    const message = `Cancellation was not accepted: ${error.message}`;
    if (state.pendingTerminal) {
      finishRequest(state.pendingTerminal.status, message);
    } else {
      streamController?.abort();
      disconnected = false;
      save();
      render('Working', message);
      void readEvents(currentGeneration);
    }
    return;
  }
  if (currentGeneration !== generation) return;
  finishRequest('Cancelled');
}

async function hydrateFromServer(signal) {
  const snapshot = await client.readSession(state.sessionId, { signal });
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  if (state.nodes.length === 0) {
    const tools = new Map();
    for (const message of messages) {
      const text = textOf(message.content);
      if (message.role === 'user' && text) addNode({ kind: 'user', text });
      if (message.role === 'assistant') {
        for (const call of message.tool_calls ?? []) {
          const node = addNode({
            kind: 'tool',
            toolId: call.id,
            name: call.function?.name ?? 'tool',
            args: summarizeArgs(call.function?.arguments ?? ''),
            status: 'Completed',
            summary: '',
            output: '',
            startedAt: null,
            endedAt: null,
            open: false,
          });
          tools.set(call.id, node);
        }
        if (text) addNode({ kind: 'assistant', text });
      }
      if (message.role === 'tool') {
        const node = tools.get(message.tool_call_id);
        if (node) node.output = previewOutput(text);
      }
    }
  }
  addNode({ kind: 'system', text: `Restored from disk, ${messages.length} messages` });
  state.lastStatus = 'Idle';
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
        await hydrateFromServer(controller.signal);
        if (currentGeneration !== generation) return;
        save();
      } else if (state.pendingSubmission) {
        state.createCommandId ??= crypto.randomUUID();
        save();
        const created = await client.createSession({ source: 'web-starter' }, {
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
      state.lastStatus = 'Working';
      save();
    }
    connecting = false;
    if (state.cancelCommandId) {
      render('Cancelling');
      await confirmCancellation(currentGeneration, controller.signal);
    } else if (state.activeRequestId) {
      render('Working');
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

async function steer(input) {
  const node = addNode({ kind: 'steer', text: input, status: 'pending', inputId: null });
  save();
  render('Working');
  const currentGeneration = generation;
  try {
    const submission = await session.send(input, {
      priority: 'now',
      commandId: crypto.randomUUID(),
      signal: operationController?.signal,
    });
    if (currentGeneration !== generation) return;
    node.status = submission.status;
    node.inputId = submission.inputId ?? null;
    if (submission.status === 'started' && submission.requestId) {
      // The previous request finished just before this arrived; it became a new turn.
      state.activeRequestId = submission.requestId;
      if (!streamController || streamController.signal.aborted) void readEvents(currentGeneration);
    }
  } catch (error) {
    if (currentGeneration !== generation) return;
    node.status = 'failed';
    node.text = `${input} (${error instanceof Error ? error.message : String(error)})`;
  }
  save();
  render(state.cancelCommandId ? 'Cancelling' : hasRequest() ? 'Working' : state.lastStatus);
}

// ---------- wiring ----------

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = promptInput.value.trim();
  if (!input || submit.disabled) return;
  promptInput.value = '';
  if (hasRequest()) {
    void steer(input);
    return;
  }
  addNode({ kind: 'user', text: input });
  state.pendingSubmission = { commandId: crypto.randomUUID(), input };
  state.pendingTerminal = null;
  save();
  void connect();
});

promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
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
