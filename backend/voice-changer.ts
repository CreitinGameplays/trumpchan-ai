import { spawn } from 'node:child_process';
import { readFileSync, watchFile, unwatchFile } from 'node:fs';
const GEMINI_OUTPUT_RATE = 24000;

interface VoiceChangerConfig {
  enabled: boolean;
  name: string;
  ffmpegFilter: string;
}

export class VoiceChanger {
  private profile: VoiceChangerConfig;
  private processor: ReturnType<typeof spawn> | null = null;
  private available = true;
  private destroyed = false;
  private stderr = '';
  private inputBytes = 0;
  private outputBytes = 0;
  private lastError: string | null = null;
  private readonly configChangeHandler = () => this.reloadProfile();

  constructor(
    private readonly ffmpegBinary: string,
    private readonly configPath: string,
    private readonly onAudio: (pcm24k: Buffer) => void
  ) {
    this.profile = this.loadVoiceChangerConfig(configPath);
    watchFile(this.configPath, { interval: 1_000 }, this.configChangeHandler);
    console.log(`[VoiceChanger] Initialized with profile: ${this.profile.name}, enabled: ${this.profile.enabled}, filter: ${this.profile.ffmpegFilter}`);
  }

  process(pcm24k: Buffer) {
    if (!pcm24k.length || this.destroyed) return;
    this.inputBytes += pcm24k.length;
    if (!this.profile.enabled || !this.available) {
      this.onAudio(pcm24k);
      return;
    }
    this.ensureProcessor();
    const stdin = this.processor?.stdin;
    if (!stdin?.writable) {
      console.warn('[VoiceChanger] Processor stdin not writable, bypassing');
      this.onAudio(pcm24k);
      return;
    }
    try {
      stdin.write(pcm24k);
    } catch (e) {
      console.error('[VoiceChanger] Failed to write to processor:', e);
      this.onAudio(pcm24k);
    }
  }

  reset() {
    this.stopProcessor();
  }

  destroy() {
    this.destroyed = true;
    unwatchFile(this.configPath, this.configChangeHandler);
    this.stopProcessor();
    console.log('[VoiceChanger] Destroyed');
  }

  getStatus() {
    return {
      configured: this.profile.enabled,
      active: this.profile.enabled && this.available && Boolean(this.processor),
      available: this.available,
      name: this.profile.name,
      inputBytes: this.inputBytes,
      outputBytes: this.outputBytes,
      lastError: this.lastError
    };
  }

  private ensureProcessor() {
    if (this.processor || this.destroyed) return;
    this.stderr = '';
    console.log(`[VoiceChanger] Starting ffmpeg process with filter: ${this.profile.ffmpegFilter}`);
    const processor = spawn(this.ffmpegBinary, [
      '-hide_banner',
      '-loglevel', 'warning',
      '-f', 's16le',
      '-ar', String(GEMINI_OUTPUT_RATE),
      '-ac', '1',
      '-i', 'pipe:0',
      '-af', this.profile.ffmpegFilter,
      '-f', 's16le',
      '-ar', String(GEMINI_OUTPUT_RATE),
      '-ac', '1',
      'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.processor = processor;
    processor.stdout.on('data', (chunk: Buffer) => {
      this.outputBytes += chunk.length;
      this.onAudio(chunk);
    });
    processor.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-2_000);
    });
    processor.once('error', (error) => this.disableAfterFailure(processor, error.message));
    processor.once('close', (code) => {
      if (this.processor !== processor) return;
      this.disableAfterFailure(processor, this.stderr.trim() || `ffmpeg exited with code ${code}`);
    });
  }

  private reloadProfile() {
    if (this.destroyed) return;
    const next = this.loadVoiceChangerConfig(this.configPath);
    if (
      next.enabled === this.profile.enabled
      && next.name === this.profile.name
      && next.ffmpegFilter === this.profile.ffmpegFilter
    ) return;
    console.log(`[VoiceChanger] Reloading profile to: ${next.name}, filter: ${next.ffmpegFilter}`);
    this.stopProcessor();
    this.profile = next;
    this.available = true;
    this.lastError = null;
  }

  private disableAfterFailure(processor: ReturnType<typeof spawn>, error: string) {
    if (this.processor !== processor) return;
    this.processor = null;
    this.available = false;
    this.lastError = error;
    console.warn(`[VoiceChanger] Failed; bypassing effect: ${error}`);
  }

  private stopProcessor() {
    const processor = this.processor;
    this.processor = null;
    if (!processor) return;
    try {
      processor.stdin?.end();
    } catch {}
    processor.kill('SIGKILL');
  }

  private loadVoiceChangerConfig(configPath: string): VoiceChangerConfig {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<VoiceChangerConfig>;
      if (typeof parsed.enabled !== 'boolean') throw new Error('enabled must be a boolean');
      if (typeof parsed.name !== 'string' || !parsed.name.trim()) throw new Error('name must be a non-empty string');
      if (typeof parsed.ffmpegFilter !== 'string' || !parsed.ffmpegFilter.trim() || parsed.ffmpegFilter.length > 2_000) {
        throw new Error('ffmpegFilter must be a non-empty string of at most 2000 characters');
      }
      return {
        enabled: parsed.enabled,
        name: parsed.name.trim(),
        ffmpegFilter: parsed.ffmpegFilter.trim()
      };
    } catch (error) {
      console.warn('[VoiceChanger] Could not load configuration; using bypass mode', {
        configPath,
        error: error instanceof Error ? error.message : String(error)
      });
      return { enabled: false, name: 'bypass', ffmpegFilter: 'anull' };
    }
  }
}