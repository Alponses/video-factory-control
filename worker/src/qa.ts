import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProbeData {
  format?: { duration?: string | number };
  streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
}

export interface QaResult {
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  durationPassed: boolean;
  resolutionPassed: boolean;
  audioPassed: boolean;
  captionsPassed: boolean | null;
  passed: boolean;
  raw: Record<string, unknown>;
}

export function evaluateProbe(probe: ProbeData): QaResult {
  const duration = Number(probe.format?.duration ?? Number.NaN);
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const width = Number(video?.width ?? 0);
  const height = Number(video?.height ?? 0);
  const hasAudio = Boolean(probe.streams?.some((stream) => stream.codec_type === 'audio'));
  const durationPassed = Number.isFinite(duration) && duration >= 61.0;
  const resolutionPassed = width === 1080 && height === 1920;
  const audioPassed = hasAudio;
  const captionsPassed = null;
  return {
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    width,
    height,
    hasAudio,
    durationPassed,
    resolutionPassed,
    audioPassed,
    captionsPassed,
    passed: durationPassed && resolutionPassed && audioPassed,
    raw: {
      durationSeconds: Number.isFinite(duration) ? duration : null,
      video: video ? { width, height } : null,
      audioStreamCount: probe.streams?.filter((stream) => stream.codec_type === 'audio').length ?? 0,
      captionsVerified: false,
    },
  };
}

export async function runQa(filePath: string, timeoutMs = 15_000): Promise<QaResult> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,width,height',
    '-of', 'json',
    filePath,
  ], { timeout: timeoutMs, maxBuffer: 1_000_000 });
  return evaluateProbe(JSON.parse(stdout) as ProbeData);
}
