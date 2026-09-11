import type { ActorType } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      actor?: {
        type: ActorType;
        email: string;
      };
      workerAccess?: {
        subject: string | null;
      };
      worker?: {
        id: string;
        secretVersion: number;
      };
    }
  }
}

export {};
