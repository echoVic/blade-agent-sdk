import { describe, expect, it } from 'vitest';
import { CommandId, ExecutionLeaseId } from '../../types/identifiers.js';
import { InMemoryAgentServerStore } from '../AgentServerStore.js';

const tenantId = 'tenant-command-abandon';
const commandId = CommandId('command-abandon-1');

describe('command abandonment', () => {
  it('resolves a sealed command terminally instead of answering in_progress forever', async () => {
    const store = new InMemoryAgentServerStore();
    const claim = await store.claimCommand(tenantId, commandId, 'fingerprint', 30_000);
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') {
      throw new Error('expected a claim');
    }
    await store.sealCommand(tenantId, commandId, claim.leaseId);
    expect(await store.claimCommand(tenantId, commandId, 'fingerprint', 30_000))
      .toMatchObject({ status: 'in_progress' });

    const abandoned = await store.abandonCommand(tenantId, commandId, 'sealed window elapsed');
    expect(abandoned).toBe(true);

    expect(await store.claimCommand(tenantId, commandId, 'fingerprint', 30_000))
      .toEqual({ status: 'abandoned', reason: 'sealed window elapsed' });
    // Idempotent: a second abandonment changes nothing.
    expect(await store.abandonCommand(tenantId, commandId, 'another reason')).toBe(false);
    expect(await store.claimCommand(tenantId, commandId, 'fingerprint', 30_000))
      .toEqual({ status: 'abandoned', reason: 'sealed window elapsed' });
  });

  it('never abandons a command that can still be released or already has a result', async () => {
    const store = new InMemoryAgentServerStore();
    const claimedId = CommandId('command-still-claimed');
    const claimed = await store.claimCommand(tenantId, claimedId, 'fingerprint', 30_000);
    if (claimed.status !== 'claimed') {
      throw new Error('expected a claim');
    }
    // A claimed command can still be released for retry, so abandoning it would
    // strand a retry that is perfectly safe.
    expect(await store.abandonCommand(tenantId, claimedId, 'too early')).toBe(false);

    const completedId = CommandId('command-completed');
    const fresh = await store.claimCommand(tenantId, completedId, 'fingerprint', 30_000);
    if (fresh.status !== 'claimed') {
      throw new Error('expected a claim');
    }
    await store.sealCommand(tenantId, completedId, fresh.leaseId);
    await store.completeCommand(tenantId, completedId, fresh.leaseId, {
      commandId: completedId,
      ok: true,
      data: {},
    } as never);
    expect(await store.abandonCommand(tenantId, completedId, 'late')).toBe(false);
    expect(await store.claimCommand(tenantId, completedId, 'fingerprint', 30_000))
      .toMatchObject({ status: 'completed' });
  });

  it('requires a reason so an abandonment is auditable', async () => {
    const store = new InMemoryAgentServerStore();
    const id = CommandId('command-needs-reason');
    const claim = await store.claimCommand(tenantId, id, 'fingerprint', 30_000);
    if (claim.status !== 'claimed') {
      throw new Error('expected a claim');
    }
    await store.sealCommand(tenantId, id, claim.leaseId);
    await expect(store.abandonCommand(tenantId, id, '   ')).rejects.toThrow(/reason/);
  });

  it('keeps the lease identity required for sealing', async () => {
    const store = new InMemoryAgentServerStore();
    const id = CommandId('command-lease-guard');
    const claim = await store.claimCommand(tenantId, id, 'fingerprint', 30_000);
    if (claim.status !== 'claimed') {
      throw new Error('expected a claim');
    }
    await expect(
      store.sealCommand(tenantId, id, ExecutionLeaseId('not-the-lease')),
    ).rejects.toThrow(/no longer active/);
  });
});
