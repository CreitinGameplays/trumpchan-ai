/**
 * Fish Audio Text-to-Speech for the non-Live backend.
 *
 * The Gemini Live API produces native streaming audio. step-3.7-flash (and most
 * OpenAI-compatible chat models) produce TEXT ONLY, so this backend synthesizes
 * speech from the model's text with Fish Audio (https://fish.audio) and emits
 * 24 kHz mono PCM16 — the exact format the frontend + voice changer already
 * consume from the Live backend.
 *
 * Fish Audio /v1/tts returns raw PCM (16-bit, mono) when format="pcm" and
 * sample_rate=24000, so no decoding is needed. We use the FREE model
 * "s2.1-pro-free".
 *
 * Sentence-chunked so long replies start speaking quickly instead of waiting for
 * the whole answer (a lightweight replacement for Live's incremental audio).
 *
 * If TTS is disabled or fails, the backend still streams captions/text so the
 * avatar keeps working (lip-sync just won't drive from audio).
 */

const FISH_TTS_URL = 'https://api.fish.audio/v1/tts';
const TARGET_RATE = 24000; // matches Gemini Live output + voice changer input

export interface FishTtsOptions {
  apiKey: string;
  /** Fish model header. Use the free tier by default. */
  model?: string;
  /** Optional voice model id (reference_id) from the Fish voice library. */
  referenceId?: string;
  enabled?: boolean;
  /** Latency/quality trade-off: 'balanced' (default) | 'normal' | 'low'. */
  latency?: 'balanced' | 'normal' | 'low';
}

/**
 * Strip symbols that break or garble Fish TTS while keeping spoken words +
 * punctuation. Captions / UI keep the original model text (emojis included);
 * only the TTS request body is cleaned.
 */
export function sanitizeTextForFishTts(raw: string): string {
  let t = String(raw ?? '');

  // Zero-width / BOM / soft hyphen / bidi marks
  t = t.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g, '');

  // Full emoji ranges (incl. presentation/modifier selectors, ZWJ sequences)
  t = t.replace(/\p{Extended_Pictographic}/gu, '');
  t = t.replace(/[\uFE0E\uFE0F]/g, ''); // variation selectors
  t = t.replace(/\u200D/g, ''); // ZWJ leftover

  // Skin tone / keycap combos leftovers
  t = t.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');
  t = t.replace(/\u20E3/g, '');

  // Markdown / chat markup (keep words; drop fences and emphasis chars)
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/__([^_]+)__/g, '$1');
  t = t.replace(/\*([^*]+)\*/g, '$1');
  t = t.replace(/_([^_]+)_/g, '$1');
  t = t.replace(/~~([^~]+)~~/g, '$1');
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\d+\.\s+/gm, '');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1'); // [text](url) → text

  // Bare URLs / emails (TTS would read them char-by-char)
  t = t.replace(/https?:\/\/\S+/gi, ' ');
  t = t.replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, ' ');
  t = t.replace(/www\.\S+/gi, ' ');

  // HTML-ish tags if the model ever emits them
  t = t.replace(/<\/?[^>\s][^>]*>/g, ' ');

  // Control chars (except newline / tab, which we collapse below)
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

  // Collapse whitespace; keep single spaces between tokens
  t = t.replace(/\s+/g, ' ').trim();

  // Drop leftover standalone markdown noise
  t = t.replace(/[*_~`#|>]{2,}/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();

  return t;
}

/**
 * Streaming-friendly TTS wrapper. Feed text deltas; it buffers until a sentence
 * boundary, synthesizes each sentence via Fish Audio, and calls onAudio with
 * PCM16 @ 24 kHz.
 */
export class FishTTS {
  private enabled: boolean;
  private apiKey: string;
  private model: string;
  private referenceId?: string;
  private latency: 'balanced' | 'normal' | 'low';
  private textBuffer = '';
  private queue: Promise<void> = Promise.resolve();
  private available = true;

  constructor(
    opts: FishTtsOptions,
    private onAudio: (pcm24k: Buffer, text: string) => void,
  ) {
    this.enabled = opts.enabled !== false && Boolean(opts.apiKey);
    this.apiKey = opts.apiKey;
    this.model = opts.model || 's2.1-pro-free';
    this.referenceId = opts.referenceId;
    this.latency = opts.latency || 'balanced';

    if (!this.enabled) {
      console.warn('[Fish-TTS] Disabled (no FISHAUDIO_KEY or TTS_ENABLED=0). Captions only.');
      return;
    }
    console.log(
      `[Fish-TTS] Ready model=${this.model}` +
        `${this.referenceId ? ` voice=${this.referenceId}` : ''} latency=${this.latency}`,
    );
  }

  isEnabled(): boolean {
    return this.enabled && this.available;
  }

  /** Feed a streamed text delta; speaks complete sentences as they form. */
  pushDelta(delta: string) {
    if (!this.isEnabled() || !delta) return;
    this.textBuffer += delta;

    // Flush every complete sentence (or on strong punctuation) so audio starts fast.
    const parts = this.textBuffer.split(/(?<=[.!?。！？\n])\s+/);
    if (parts.length > 1) {
      const complete = parts.slice(0, -1).join(' ').trim();
      this.textBuffer = parts[parts.length - 1];
      if (complete) this.enqueue(complete);
    }
  }

  /** Flush whatever text remains (call on turn end). */
  flush() {
    if (!this.isEnabled()) {
      this.textBuffer = '';
      return;
    }
    const rest = this.textBuffer.trim();
    this.textBuffer = '';
    if (rest) this.enqueue(rest);
  }

  /** Speak an entire block at once (non-streaming path). */
  speak(text: string) {
    if (!this.isEnabled()) return;
    const t = String(text || '').trim();
    if (t) this.enqueue(t);
  }

  reset() {
    this.textBuffer = '';
  }

  /** Serialize synthesis so PCM chunks reach the frontend in order. */
  private enqueue(text: string) {
    // Cleanup is TTS-only: model output (captions) stays unchanged upstream.
    const spoken = sanitizeTextForFishTts(text);
    if (!spoken) {
      console.log(
        `[Fish-TTS] Skip empty after sanitize (was "${String(text).slice(0, 40).replace(/\n/g, ' ')}")`,
      );
      return;
    }
    this.queue = this.queue.then(() => this.synth(spoken, text)).catch((e) => {
      console.warn('[Fish-TTS] synth error:', e?.message ?? e);
    });
  }

  private async synth(spoken: string, original?: string) {
    if (!this.available) return;
    if (!spoken) return;

    const body: Record<string, unknown> = {
      text: spoken,
      format: 'pcm', // raw 16-bit mono PCM — no decoding needed
      sample_rate: TARGET_RATE,
      latency: this.latency,
      normalize: true,
    };
    if (this.referenceId) body.reference_id = this.referenceId;

    try {
      const resp = await fetch(FISH_TTS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          model: this.model,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.warn(`[Fish-TTS] HTTP ${resp.status}: ${errText.slice(0, 200)}`);
        // 401/402/403 → auth/quota issues: stop retrying to avoid spam.
        if (resp.status === 401 || resp.status === 402 || resp.status === 403) {
          console.warn('[Fish-TTS] Disabling TTS (auth/quota); captions only.');
          this.available = false;
        }
        return;
      }

      const arrayBuf = await resp.arrayBuffer();
      const pcm = Buffer.from(arrayBuf);
      if (pcm.length) {
        this.onAudio(pcm, spoken);
        console.log(`[Fish-TTS] Spoke ${pcm.length}B PCM24k for "${spoken.slice(0, 60)}"`);
        if (original && original !== spoken) {
          console.log(
            `[Fish-TTS] Sanitized TTS text (kept punctuation, stripped emoji/markup)`,
          );
        }
      }
    } catch (e: any) {
      console.warn(`[Fish-TTS] request failed: ${e?.message ?? e}`);
    }
  }
}
