import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { Abi, Address } from 'abitype/zod';
import { verifyMessage } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

test('bounded Zod arrays reject excess input before parsing elements', () => {
  let parsed = 0;
  const element = z.string().refine(() => { parsed += 1; return true; });
  const result = z.array(element).max(2).safeParse(Array(20000).fill('test'));
  assert.equal(result.success, false);
  assert.equal(result.error.issues.length, 1);
  assert.equal(result.error.issues[0].code, 'too_big');
  assert.equal(parsed, 0);
});

test('abitype validates normal and malformed wallet ABI data with the installed peer', () => {
  const abi = [{
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  }];
  assert.equal(Abi.safeParse(abi).success, true);
  assert.equal(Abi.safeParse([{ type: 'function', name: 'invalid', inputs: 'not-an-array', outputs: [] }]).success, false);
  assert.equal(Address.safeParse('0x0000000000000000000000000000000000000001').success, true);
  assert.equal(Address.safeParse('not-an-address').success, false);
});

test('viem verifies a transient challenge signature and rejects a changed message', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const message = 'Isolated test challenge';
  const signature = await account.signMessage({ message });
  assert.equal(await verifyMessage({ address: account.address, message, signature }), true);
  assert.equal(await verifyMessage({ address: account.address, message: 'Different challenge', signature }), false);
});

test('WalletConnect provider module loads without initiating a connection', async () => {
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
  assert.equal(typeof EthereumProvider.init, 'function');
});
