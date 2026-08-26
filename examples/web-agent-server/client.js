import { AgentClient } from '@blade-ai/agent-sdk/browser';

const form = document.querySelector('#prompt-form');
const promptInput = document.querySelector('#prompt');
const transcript = document.querySelector('#transcript');
const status = document.querySelector('#status');
const sessionLabel = document.querySelector('#session-id');
const submit = document.querySelector('#submit');

if (!form || !promptInput || !transcript || !status || !sessionLabel || !submit) {
  throw new Error('Web Agent example markup is incomplete');
}

const client = new AgentClient({
  baseUrl: `${window.location.origin}/v1/agent`,
  client: {
    name: 'blade-golden-path',
    version: '1.0.0',
  },
  headers: {
    authorization: 'Bearer local-demo',
  },
});

let session;

function append(role, content) {
  const article = document.createElement('article');
  article.className = `message message-${role}`;
  const label = document.createElement('span');
  label.className = 'message-role';
  label.textContent = role;
  const text = document.createElement('p');
  text.textContent = content;
  article.append(label, text);
  transcript.append(article);
  transcript.scrollTop = transcript.scrollHeight;
  return text;
}

async function ensureSession() {
  session ??= await client.createSession({ source: 'web-golden-path' });
  sessionLabel.textContent = session.sessionId;
  return session;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = promptInput.value.trim();
  if (!prompt) {
    return;
  }
  promptInput.value = '';
  promptInput.disabled = true;
  submit.disabled = true;
  status.textContent = 'Running';
  append('user', prompt);
  const assistant = append('assistant', '');
  try {
    const activeSession = await ensureSession();
    await activeSession.send(prompt);
    for await (const event of activeSession.events()) {
      if (event.type !== 'session.stream') {
        continue;
      }
      if (event.data.type === 'content') {
        assistant.textContent += event.data.delta;
      }
      if (event.data.type === 'result') {
        status.textContent =
          event.data.subtype === 'success' ? 'Ready' : 'Failed';
        break;
      }
    }
  } catch (error) {
    status.textContent = 'Failed';
    assistant.textContent =
      error instanceof Error ? error.message : String(error);
  } finally {
    promptInput.disabled = false;
    submit.disabled = false;
    promptInput.focus();
  }
});

status.textContent = 'Ready';
