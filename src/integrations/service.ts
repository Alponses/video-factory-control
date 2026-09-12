import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ActorType, Platform, Prisma, type IntegrationAccount, type PrismaClient } from '@prisma/client';
import { decryptSecret, encryptSecret, integrationAad } from './crypto.js';
import { IntegrationError } from './errors.js';

export const INTEGRATION_STATUSES = ['DISCONNECTED', 'CONNECTED', 'TOKEN_EXPIRED', 'REAUTH_REQUIRED', 'INSUFFICIENT_SCOPE', 'ERROR'] as const;
export type IntegrationStatus = typeof INTEGRATION_STATUSES[number];

export interface ConnectedIntegrationInput {
  profileId: string;
  provider: Platform;
  accountId: string;
  displayName?: string | null;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date | null;
  refreshExpiresAt?: Date | null;
  scopes: string[];
  readiness: string;
  metadata?: Record<string, unknown>;
}

export interface DecryptedIntegration {
  id: string;
  profileId: string;
  provider: Platform;
  accountId: string;
  displayName: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  refreshExpiresAt: Date | null;
  scopes: string[];
  status: IntegrationStatus;
  readiness: string | null;
  version: number;
  metadata: Record<string, unknown>;
}

function scopes(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function metadata(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Prisma.JsonObject : {};
}

function providerFromString(value: string): Platform {
  if (!Object.values(Platform).includes(value as Platform)) throw new IntegrationError('PROFILE_PROVIDER_MISMATCH', 'Integration provider is not supported');
  return value as Platform;
}

function json(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function storeConnectedIntegration(prisma: PrismaClient, keyBase64: string, input: ConnectedIntegrationInput): Promise<IntegrationAccount> {
  const profile = await prisma.profile.findUnique({ where: { id: input.profileId } });
  if (!profile) throw new IntegrationError('PROFILE_NOT_FOUND', 'Profile was not found');
  if (profile.platform !== input.provider) throw new IntegrationError('PROFILE_PROVIDER_MISMATCH', 'Profile platform does not match integration provider');

  const [byProfile, byAccount] = await Promise.all([
    prisma.integrationAccount.findUnique({ where: { profileId: input.profileId } }),
    prisma.integrationAccount.findUnique({ where: { provider_accountId: { provider: input.provider, accountId: input.accountId } } }),
  ]);
  if (byProfile && byAccount && byProfile.id !== byAccount.id) throw new IntegrationError('INTEGRATION_ACCOUNT_CONFLICT', 'Provider account is already linked to a different profile');
  if (byAccount?.profileId && byAccount.profileId !== input.profileId) throw new IntegrationError('INTEGRATION_ACCOUNT_CONFLICT', 'Provider account is already linked to a different profile');

  const existing = byProfile ?? byAccount;
  const id = existing?.id ?? randomUUID();
  const encryptedAccessToken = encryptSecret(input.accessToken, keyBase64, integrationAad(input.provider, id, 'access'));
  const encryptedRefreshToken = input.refreshToken !== undefined
    ? encryptSecret(input.refreshToken, keyBase64, integrationAad(input.provider, id, 'refresh'))
    : existing?.encryptedRefreshToken ?? null;

  return prisma.integrationAccount.upsert({
    where: { id },
    create: {
      id,
      profileId: input.profileId,
      provider: input.provider,
      accountId: input.accountId,
      displayName: input.displayName ?? null,
      encryptedAccessToken,
      encryptedRefreshToken,
      expiresAt: input.expiresAt ?? null,
      refreshExpiresAt: input.refreshExpiresAt ?? null,
      scopes: input.scopes,
      status: 'CONNECTED',
      readiness: input.readiness,
      metadata: json(input.metadata ?? {}),
    },
    update: {
      profileId: input.profileId,
      provider: input.provider,
      accountId: input.accountId,
      displayName: input.displayName ?? null,
      encryptedAccessToken,
      encryptedRefreshToken,
      expiresAt: input.expiresAt ?? null,
      refreshExpiresAt: input.refreshExpiresAt ?? null,
      scopes: input.scopes,
      status: 'CONNECTED',
      readiness: input.readiness,
      metadata: json(input.metadata ?? {}),
      version: { increment: 1 },
      refreshClaimedAt: null,
      refreshClaimExpiresAt: null,
      refreshClaimedBy: null,
    },
  });
}

export async function loadIntegrationForProfile(prisma: PrismaClient, keyBase64: string, profileId: string, expectedProvider: Platform): Promise<DecryptedIntegration> {
  const profile = await prisma.profile.findUnique({ where: { id: profileId }, include: { integrationAccount: true } });
  if (!profile) throw new IntegrationError('PROFILE_NOT_FOUND', 'Profile was not found');
  if (profile.platform !== expectedProvider) throw new IntegrationError('PROFILE_PROVIDER_MISMATCH', 'Profile platform does not match publication provider');
  const row = profile.integrationAccount;
  if (!row || row.status !== 'CONNECTED' || !row.encryptedAccessToken) throw new IntegrationError('INTEGRATION_NOT_CONNECTED', 'Social integration is not connected');
  if (providerFromString(row.provider) !== expectedProvider) throw new IntegrationError('PROFILE_PROVIDER_MISMATCH', 'Integration provider does not match profile');
  try {
    return {
      id: row.id,
      profileId,
      provider: expectedProvider,
      accountId: row.accountId,
      displayName: row.displayName,
      accessToken: decryptSecret(row.encryptedAccessToken, keyBase64, integrationAad(expectedProvider, row.id, 'access')),
      refreshToken: row.encryptedRefreshToken ? decryptSecret(row.encryptedRefreshToken, keyBase64, integrationAad(expectedProvider, row.id, 'refresh')) : null,
      expiresAt: row.expiresAt,
      refreshExpiresAt: row.refreshExpiresAt,
      scopes: scopes(row.scopes),
      status: row.status as IntegrationStatus,
      readiness: row.readiness,
      version: row.version,
      metadata: metadata(row.metadata),
    };
  } catch {
    await prisma.integrationAccount.update({ where: { id: row.id }, data: { status: 'ERROR', readiness: 'REAUTH_REQUIRED', version: { increment: 1 } } }).catch(() => undefined);
    throw new IntegrationError('INTEGRATION_DECRYPT_FAILED', 'Stored integration credentials cannot be decrypted');
  }
}

export async function claimTokenRefresh(prisma: PrismaClient, integrationId: string, owner: string, now: Date, leaseSeconds = 60): Promise<boolean> {
  const expiresAt = new Date(now.getTime() + leaseSeconds * 1000);
  await prisma.$executeRaw(Prisma.sql`
    UPDATE integration_accounts
    SET refreshClaimedAt = ${now}, refreshClaimExpiresAt = ${expiresAt}, refreshClaimedBy = ${owner}
    WHERE id = ${integrationId}
      AND (refreshClaimExpiresAt IS NULL OR refreshClaimExpiresAt <= ${now} OR refreshClaimedBy = ${owner})
  `);
  const row = await prisma.integrationAccount.findUnique({ where: { id: integrationId }, select: { refreshClaimedBy: true, refreshClaimExpiresAt: true } });
  return row?.refreshClaimedBy === owner && row.refreshClaimExpiresAt?.getTime() === expiresAt.getTime();
}

export async function releaseTokenRefresh(prisma: PrismaClient, integrationId: string, owner: string): Promise<void> {
  await prisma.integrationAccount.updateMany({ where: { id: integrationId, refreshClaimedBy: owner }, data: { refreshClaimedAt: null, refreshClaimExpiresAt: null, refreshClaimedBy: null } });
}

export interface RefreshedTokenInput {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date | null;
  refreshExpiresAt?: Date | null;
  scopes?: string[];
}

export async function persistRefreshedTokens(prisma: PrismaClient, keyBase64: string, integration: DecryptedIntegration, owner: string, input: RefreshedTokenInput): Promise<void> {
  const encryptedAccessToken = encryptSecret(input.accessToken, keyBase64, integrationAad(integration.provider, integration.id, 'access'));
  const encryptedRefreshToken = input.refreshToken !== undefined
    ? encryptSecret(input.refreshToken, keyBase64, integrationAad(integration.provider, integration.id, 'refresh'))
    : undefined;
  const data: Prisma.IntegrationAccountUpdateManyMutationInput = {
    encryptedAccessToken,
    expiresAt: input.expiresAt ?? null,
    lastRefreshAt: new Date(),
    status: 'CONNECTED',
    version: { increment: 1 },
    refreshClaimedAt: null,
    refreshClaimExpiresAt: null,
    refreshClaimedBy: null,
  };
  if (encryptedRefreshToken !== undefined) data.encryptedRefreshToken = encryptedRefreshToken;
  if (input.refreshExpiresAt !== undefined) data.refreshExpiresAt = input.refreshExpiresAt;
  if (input.scopes !== undefined) data.scopes = input.scopes;
  const updated = await prisma.integrationAccount.updateMany({ where: { id: integration.id, refreshClaimedBy: owner }, data });
  if (updated.count !== 1) throw new IntegrationError('TOKEN_REFRESH_IN_PROGRESS', 'Token refresh ownership changed', true);
}

function stateHash(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

export async function createOAuthTransaction(prisma: PrismaClient, provider: Platform, profileId: string, actor: string, redirectUri: string, now = new Date(), ttlSeconds = 600): Promise<{ id: string; state: string }> {
  const profile = await prisma.profile.findUnique({ where: { id: profileId } });
  if (!profile) throw new IntegrationError('PROFILE_NOT_FOUND', 'Profile was not found');
  if (profile.platform !== provider) throw new IntegrationError('PROFILE_PROVIDER_MISMATCH', 'OAuth provider does not match profile');
  const state = randomBytes(32).toString('base64url');
  const created = await prisma.oAuthTransaction.create({ data: {
    profileId,
    provider,
    actor,
    stateHash: stateHash(state),
    redirectUri,
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    metadata: {},
  } });
  return { id: created.id, state };
}

export async function consumeOAuthTransaction(prisma: PrismaClient, provider: Platform, state: string | undefined, now = new Date()): Promise<{ id: string; profileId: string; actor: string; redirectUri: string }> {
  if (!state) throw new IntegrationError('OAUTH_STATE_MISSING', 'OAuth state is required');
  const hash = stateHash(state);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM oauth_transactions WHERE stateHash = ${hash} FOR UPDATE`);
    const row = await tx.oAuthTransaction.findUnique({ where: { stateHash: hash } });
    if (!row) throw new IntegrationError('OAUTH_STATE_INVALID', 'OAuth state is invalid');
    if (row.provider !== provider) throw new IntegrationError('OAUTH_PROVIDER_MISMATCH', 'OAuth callback provider does not match transaction');
    if (row.usedAt) throw new IntegrationError('OAUTH_STATE_USED', 'OAuth state was already used');
    if (row.expiresAt.getTime() <= now.getTime()) throw new IntegrationError('OAUTH_STATE_EXPIRED', 'OAuth state expired');
    await tx.oAuthTransaction.update({ where: { id: row.id }, data: { usedAt: now } });
    return { id: row.id, profileId: row.profileId, actor: row.actor, redirectUri: row.redirectUri };
  });
}

export async function disconnectIntegration(prisma: PrismaClient, profileId: string, actor: string, requestId?: string): Promise<void> {
  const row = await prisma.integrationAccount.findUnique({ where: { profileId } });
  if (!row) return;
  await prisma.$transaction(async (tx) => {
    await tx.integrationAccount.update({ where: { id: row.id }, data: {
      encryptedAccessToken: null,
      encryptedRefreshToken: null,
      expiresAt: null,
      refreshExpiresAt: null,
      status: 'DISCONNECTED',
      readiness: 'REAUTH_REQUIRED',
      refreshClaimedAt: null,
      refreshClaimExpiresAt: null,
      refreshClaimedBy: null,
      version: { increment: 1 },
    } });
    await tx.auditLog.create({ data: {
      actorType: ActorType.ADMIN,
      actor,
      action: 'INTEGRATION_DISCONNECTED',
      entityType: 'INTEGRATION_ACCOUNT',
      entityId: row.id,
      ...(requestId ? { requestId } : {}),
      beforeData: json({ provider: row.provider, accountId: row.accountId, status: row.status }),
      afterData: json({ provider: row.provider, accountId: row.accountId, status: 'DISCONNECTED' }),
    } });
  });
}

export async function recordIntegrationConnectedAudit(prisma: PrismaClient, integration: IntegrationAccount, actor: string, reconnect: boolean, requestId?: string): Promise<void> {
  await prisma.auditLog.create({ data: {
    actorType: ActorType.ADMIN,
    actor,
    action: reconnect ? 'INTEGRATION_RECONNECTED' : 'INTEGRATION_CONNECTED',
    entityType: 'INTEGRATION_ACCOUNT',
    entityId: integration.id,
    ...(requestId ? { requestId } : {}),
    afterData: json({ provider: integration.provider, accountId: integration.accountId, profileId: integration.profileId, status: integration.status, readiness: integration.readiness }),
  } });
}
