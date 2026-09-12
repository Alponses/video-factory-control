import { PrismaClient } from '@prisma/client';

let prismaSingleton: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  prismaSingleton ??= new PrismaClient({
    log: process.env.NODE_ENV === 'test' ? ['error'] : ['warn', 'error'],
  });
  return prismaSingleton;
}

export async function disconnectPrisma(): Promise<void> {
  if (!prismaSingleton) return;
  await prismaSingleton.$disconnect();
  prismaSingleton = undefined;
}
