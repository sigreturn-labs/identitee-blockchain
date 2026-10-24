// Smoke check of the public testnet: blocks advance and get finalized, chain properties, runtime API.
//   npx tsx src/check-testnet.ts [wss://rpc.identit.ee]
// Prints a human summary, then one last line `RESULT OK|FAIL best=<n> finalized=<n> [reason=...]`,
// easy to grep from a script or a timer.
// Exit code 0 only if every check passed.
import { ApiPromise, WsProvider } from '@polkadot/api';

const ws = process.argv[2] ?? 'wss://rpc.identit.ee';
const EXPECTED = { ss58Format: 2426, tokenSymbol: 'IDT', tokenDecimals: 12 };
// Any account works here: the call only shows that the runtime API answers.
const PROBE_ACCOUNT = '5HjoQrHXNbnGypfyE7f7rV6URCz7pvR9SVzZ3krs298wMLog';

let best = -1;
let finalized = -1;
const result = (ok: boolean, reason?: string): never => {
  console.log(`RESULT ${ok ? 'OK' : 'FAIL'} best=${best} finalized=${finalized}${reason ? ` reason=${reason.replace(/\s+/g, '_')}` : ''}`);
  process.exit(ok ? 0 : 1);
};
// A node that does not answer must not hang the check.
setTimeout(() => result(false, 'timeout after 60 s'), 60_000).unref();

const provider = new WsProvider(ws, false);
try {
  await provider.connect();
  const api = await ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true });
  const heads = async (): Promise<[number, number]> => [
    (await api.rpc.chain.getHeader()).number.toNumber(),
    (await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead())).number.toNumber(),
  ];
  const before = await heads();
  await new Promise((r) => setTimeout(r, 12_000));
  const after = await heads();
  [best, finalized] = after;
  const props = (await api.rpc.system.properties()).toPrimitive() as Record<string, unknown>;
  // A single token: polkadot.js returns arrays for tokenSymbol and tokenDecimals.
  const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
  const properties = { ss58Format: props.ss58Format, tokenSymbol: first(props.tokenSymbol), tokenDecimals: first(props.tokenDecimals) };
  const trustLevel = (await api.call.identiteeApi.trustLevel(PROBE_ACCOUNT)).toHuman();
  console.log({ best: [before[0], after[0]], finalized: [before[1], after[1]], properties, trustLevel });
  await api.disconnect();
  if (!(after[0] > before[0])) result(false, 'best block did not advance in 12 s');
  if (!(after[1] > before[1])) result(false, 'finalized block did not advance in 12 s');
  for (const [key, value] of Object.entries(EXPECTED)) {
    if (properties[key as keyof typeof properties] !== value) result(false, `property ${key} is ${String(properties[key as keyof typeof properties])}, expected ${value}`);
  }
  result(true);
} catch (e) {
  // A WebSocket failure is an ErrorEvent, whose text is in `message` without being an Error.
  const message = (e as { message?: unknown })?.message;
  result(false, typeof message === 'string' && message ? message : `cannot reach ${ws}`);
}
