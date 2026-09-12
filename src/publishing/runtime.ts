import { Platform } from '@prisma/client';
import type { AppConfig } from '../config.js';
import type { R2Storage } from '../storage/r2.js';
import type { HttpTransport } from './http.js';
import { PublishingProviderRegistry, type PublishingProvider } from './provider.js';
import { FacebookPublishingProvider } from './providers/facebook.js';
import { TikTokPublishingProvider } from './providers/tiktok.js';
import { YouTubePublishingProvider } from './providers/youtube.js';

export function createPublishingProviderRegistry(config: AppConfig, transport: HttpTransport, storage: R2Storage): PublishingProviderRegistry {
  const providers: PublishingProvider[] = [];
  if (config.tiktok) providers.push(new TikTokPublishingProvider(transport, storage));
  if (config.youtube) providers.push(new YouTubePublishingProvider(transport, storage));
  if (config.facebook) providers.push(new FacebookPublishingProvider(transport, storage, config.facebook.graphApiVersion));
  return new PublishingProviderRegistry(providers);
}

export function configuredPublishingPlatforms(config: AppConfig): Platform[] {
  const platforms: Platform[] = [];
  if (config.tiktok) platforms.push(Platform.TIKTOK);
  if (config.youtube) platforms.push(Platform.YOUTUBE);
  if (config.facebook) platforms.push(Platform.FACEBOOK);
  return platforms;
}
