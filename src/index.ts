export const VIDEO_FACTORY_VERSION = '5.0.0-phase.1';
export const VIDEO_FACTORY_PHASE = 1 as const;

export interface RuntimeDescriptor {
  name: 'video-factory-v5';
  phase: 1;
  nodeMajor: 22;
}

export function runtimeDescriptor(): RuntimeDescriptor {
  return {
    name: 'video-factory-v5',
    phase: VIDEO_FACTORY_PHASE,
    nodeMajor: 22,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${JSON.stringify(runtimeDescriptor())}\n`);
}
