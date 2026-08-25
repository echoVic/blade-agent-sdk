import { describe, expect, it, vi } from 'vitest';
import { CommandId, SessionId } from '../../types/identifiers.js';
import { OpenTelemetryAgentServerTelemetry } from '../OpenTelemetryAgentServerTelemetry.js';

describe('OpenTelemetryAgentServerTelemetry', () => {
  it('emits payload-free metrics and audit records by default', async () => {
    const auditSink = vi.fn(async () => {});
    const telemetry = new OpenTelemetryAgentServerTelemetry({ auditSink });

    expect(() =>
      telemetry.recordCommand({
        commandType: 'input.submit',
        tenantId: 'tenant-secret',
        subject: 'user-secret',
        durationMs: 10,
        outcome: 'success',
      }),
    ).not.toThrow();
    expect(() =>
      telemetry.recordEvent({
        tenantId: 'tenant-secret',
        sessionId: SessionId('session-1'),
        eventType: 'session.stream',
      }),
    ).not.toThrow();
    await telemetry.writeAudit({
      occurredAt: new Date().toISOString(),
      tenantId: 'tenant-secret',
      subject: 'user-secret',
      commandId: CommandId('command-1'),
      commandType: 'input.submit',
      sessionId: SessionId('session-1'),
      outcome: 'success',
    });

    expect(auditSink).toHaveBeenCalledWith(
      expect.not.objectContaining({
        input: expect.anything(),
        prompt: expect.anything(),
        apiKey: expect.anything(),
      }),
    );
  });
});
