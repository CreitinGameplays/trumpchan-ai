/**
 * Smoke-test Gemini Robotics-ER 1.6 via the configured proxy/key.
 * Usage: npx tsx test_code/robotics-er-smoke.ts
 */
import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createRequire } from 'node:module';

// Minimal 8x8 red JPEG (valid) as a tiny vision probe
const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAIAA8DASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';

async function main() {
  const key = process.env.XINJIANYA_KEY || process.env.GEMINI_API_KEY;
  if (!key) {
    console.error('No XINJIANYA_KEY or GEMINI_API_KEY');
    process.exit(1);
  }
  const baseUrl = process.env.ROBOTICS_ER_BASE_URL || process.env.XINJIANYA_BASE_URL || 'https://aihub.071129.xyz';
  const modelId = process.env.ROBOTICS_ER_MODEL || 'gemini-robotics-er-1.6-preview';

  console.log('Testing Robotics-ER', { modelId, baseUrl: baseUrl.slice(0, 40) + '…' });

  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: modelId }, { baseUrl } as any);

  const t0 = Date.now();
  const result = await model.generateContent({
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: TINY_JPEG_B64 } },
          {
            text:
              'Return ONLY JSON: {"reasoning":"test","steps":[{"name":"look_at","args":{"target":"browser"}}]} ' +
              'Allowed step names: look_at, turn, walk, walk_toward, inspect_browser, reset_pose, stop_moving.',
          },
        ],
      },
    ],
    generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
  });

  const text = result.response.text();
  console.log('latency_ms', Date.now() - t0);
  console.log('response:', text);
}

main().catch((e) => {
  console.error('SMOKE FAIL', e?.message || e);
  process.exit(1);
});
