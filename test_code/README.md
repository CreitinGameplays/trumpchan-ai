# Test Code

This directory contains automated test scripts for verifying the functionalities of the VRoid viewer and its API.

## Running Tests

To run the test scripts, ensure that the API server is currently working. You can start everything (Vite, backend server, and AI backend) in your primary terminal with:

```bash
npm run dev
```

`npm run dev` now auto-starts the AI backend, so you no longer need to launch `backend/ai-server.ts` yourself. Then, in a secondary terminal, you can execute the test scripts using `npx tsx` (which allows running TypeScript files directly in Node.js).

### Vowel Test
The `vowel-test.ts` script verifies the facial expression API by cycling through the `A, E, I, O, U` (`aa`, `ee`, `ih`, `oh`, `ou`) blendshapes and then tests the model's explicit `lookAt` tracking.

**To run the test:**

```bash
npx -y tsx test_code/vowel-test.ts
```

*(Adding `-y` helps bypass any prompts to install `tsx` during execution).*
