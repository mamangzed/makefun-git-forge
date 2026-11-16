// main.ts — entrypoint: bind an ephemeral port, register with the harness,
// then long-poll /done until the trial ends and exit 0.
//
// The harness answers /done with {"done": false} immediately; we never hold
// a request open. All state lives in the in-memory store; nothing here
// reads the wall clock or uses randomness.

import { createApp } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const nowIso = process.env.MAKEFUN_TRIAL_NOW;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const { server } = createApp({ shopToken, nowIso });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('could not bind an ephemeral port'));
    });
  });

  if (envUrl) {
    const register = await fetch(`${envUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    if (!register.ok) {
      throw new Error(`register failed: ${register.status}`);
    }
    let delay = 250;
    for (;;) {
      const res = await fetch(`${envUrl}/done`);
      if (res.ok) {
        const body = (await res.json()) as { done?: boolean };
        if (body.done) break;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 2000);
    }
  } else {
    // No harness: serve forever (useful for local smoke tests).
    console.log(`listening on 127.0.0.1:${port}`);
    await new Promise(() => undefined);
  }

  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
