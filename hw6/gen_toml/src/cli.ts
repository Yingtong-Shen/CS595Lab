import { ethers } from 'ethers';
import { NoirCircuitTomlGenerator } from './CircuitTomlGenerator';
import { Fr } from '@aztec/aztec.js/fields';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const CONTRACT_ADDRESS = '0xA0A7f858A279474352e8C4b50e390AF44fd33CCa';
const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';

const DEPOSIT_CIRCUIT_DIR = path.resolve(__dirname, '../../contracts/deposit_circuit');
const WITHDRAW_CIRCUIT_DIR = path.resolve(__dirname, '../../contracts/withdraw_circuit');

const WHIRLWIND_ABI = [
  'function deposit(bytes calldata proof, bytes32 newRoot, bytes32 commitment) external payable',
  'function withdraw(bytes calldata proof, bytes32 nullifier) external',
  'function currentRoot() external view returns (bytes32)',
  'function depositIndex() external view returns (uint256)',
  'event Deposit(bytes32 newRoot, bytes32 commitment, uint256 index)',
  'event Withdraw(address indexed recipient, bytes32 nullifier)',
];

function extractProof(proofPath: string, numPublicInputs: number): string {
  const proofBytes = fs.readFileSync(proofPath);
  const hexStr = proofBytes.toString('hex');
  const skipChars = 8 + numPublicInputs * 64;
  return '0x' + hexStr.slice(skipChars);
}

function run(cmd: string, cwd: string) {
  console.log(`  > ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function saveSecrets(index: number, id: string, r: string) {
  const secretsFile = path.resolve(__dirname, '../secrets.json');
  let secrets: Record<string, { id: string; r: string }> = {};
  if (fs.existsSync(secretsFile)) {
    secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
  }
  secrets[index.toString()] = { id, r };
  fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2));
  console.log(`  Secrets saved for index ${index}`);
}

function loadSecrets(index: number): { id: string; r: string } {
  const secretsFile = path.resolve(__dirname, '../secrets.json');
  if (!fs.existsSync(secretsFile)) {
    throw new Error('No secrets.json found. You must deposit first.');
  }
  const secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
  const entry = secrets[index.toString()];
  if (!entry) {
    throw new Error(`No secrets found for deposit index ${index}`);
  }
  return entry;
}

async function syncTree(): Promise<{ generator: NoirCircuitTomlGenerator; depositCount: number }> {
  console.log('\n--- Syncing Merkle tree from on-chain events ---');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, WHIRLWIND_ABI, provider);

  const currentRoot = await contract.currentRoot();
  const depositIndex = await contract.depositIndex();
  console.log(`  On-chain root: ${currentRoot}`);
  console.log(`  Total deposits: ${depositIndex.toString()}`);

  const generator = new NoirCircuitTomlGenerator();
  await generator.init();

  const filter = contract.filters.Deposit();
  const events = await contract.queryFilter(filter, 10660080, 'latest');

  console.log(`  Found ${events.length} deposit event(s)`);

  for (const event of events) {
    const log = event as ethers.EventLog;
    const commitment = log.args[1];
    const idx = Number(log.args[2]);
    console.log(`  - Deposit #${idx}: commitment=${commitment}`);
    const commitmentFr = Fr.fromString(commitment);
    (generator as any).tree.insert(commitmentFr);
  }

  const localRoot = (generator as any).tree.root().toString();
  console.log(`  Local root:    ${localRoot}`);
  console.log(`  Roots match:   ${localRoot === currentRoot.toString().toLowerCase() ||
    '0x' + localRoot.slice(2).padStart(64, '0') === currentRoot.toString().toLowerCase()}`);
  console.log('  Sync complete!\n');
  return { generator, depositCount: Number(depositIndex) };
}

async function doDeposit() {
  console.log('\n=== DEPOSIT ===');
  if (!PRIVATE_KEY) { console.error('Error: Set PRIVATE_KEY environment variable'); process.exit(1); }

  const { generator, depositCount } = await syncTree();

  const id = Fr.random();
  const r = Fr.random();
  console.log(`  Generated id: ${id.toString()}`);
  console.log(`  Generated r:  ${r.toString()}`);
  console.log(`  Deposit index: ${depositCount}`);

  const depositToml = generator.gentoml('deposit', id, r);
  console.log('\n  Deposit Prover.toml:');
  console.log(depositToml);

  const newRootMatch = depositToml.match(/newRoot = "([^"]+)"/);
  const commitmentMatch = depositToml.match(/commitment = "([^"]+)"/);
  if (!newRootMatch || !commitmentMatch) throw new Error('Failed to parse TOML');
  const newRoot = newRootMatch[1];
  const commitment = commitmentMatch[1];

  fs.writeFileSync(path.join(DEPOSIT_CIRCUIT_DIR, 'Prover.toml'), depositToml);
console.log('\n  Generating proof...');
  const depositScript = `#!/bin/bash
set -e
cd ${DEPOSIT_CIRCUIT_DIR}
rm -f ./target/deposit_circuit.gz ./target/proof
nargo execute
/root/.bb/bb prove --scheme ultra_honk --oracle_hash keccak -b ./target/deposit_circuit.json -w ./target/deposit_circuit.gz -o ./target
`;
  fs.writeFileSync('/tmp/deposit_prove.sh', depositScript);
  run('bash /tmp/deposit_prove.sh', DEPOSIT_CIRCUIT_DIR);

  const proof = extractProof(path.join(DEPOSIT_CIRCUIT_DIR, 'target/proof'), 4);
  console.log(`  Proof extracted (${proof.length} hex chars)`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, WHIRLWIND_ABI, wallet);

  console.log('\n  Submitting deposit transaction...');
  const tx = await contract.deposit(proof, newRoot, commitment, { value: ethers.parseEther('0.1') });
  console.log(`  Tx hash: ${tx.hash}`);
  console.log('  Waiting for confirmation...');
  const receipt = await tx.wait();
  console.log(`  Confirmed in block ${receipt!.blockNumber}`);

  saveSecrets(depositCount, id.toString(), r.toString());
  console.log('\n=== DEPOSIT COMPLETE ===\n');
}

async function doWithdraw(index: number) {
  console.log(`\n=== WITHDRAW (index ${index}) ===`);
  if (!PRIVATE_KEY) { console.error('Error: Set PRIVATE_KEY environment variable'); process.exit(1); }

  const { id: idStr, r: rStr } = loadSecrets(index);
  const id = Fr.fromString(idStr);
  const r = Fr.fromString(rStr);
  console.log(`  Loaded id: ${idStr}`);
  console.log(`  Loaded r:  ${rStr}`);

  const { generator } = await syncTree();
  const tree = (generator as any).tree;
  const proofData = tree.proof(index);
  const hashPath = proofData.pathElements;
  const root = proofData.root;

  const numToFr = (num: number): Fr => {
    const hex = num.toString(16).padStart(64, '0');
    return Fr.fromString('0x' + hex);
  };
  const idxFr = numToFr(index);

  const withdrawToml = `
r = "${r.toString()}"
index = "${idxFr.toString()}"
hashpath = [${hashPath.map((fr: Fr) => `"${fr.toString()}"`).join(', ')}]
root = "${root.toString()}"
id = "${id.toString()}"
  `.trim();

  console.log('\n  Withdraw Prover.toml:');
  console.log(withdrawToml);

  fs.writeFileSync(path.join(WITHDRAW_CIRCUIT_DIR, 'Prover.toml'), withdrawToml);

  console.log('\n  Generating proof...');
  const withdrawScript = `#!/bin/bash
set -e
cd ${WITHDRAW_CIRCUIT_DIR}
rm -f ./target/withdraw_circuit.gz ./target/proof
nargo execute
/root/.bb/bb prove --scheme ultra_honk --oracle_hash keccak -b ./target/withdraw_circuit.json -w ./target/withdraw_circuit.gz -o ./target
`;
  fs.writeFileSync('/tmp/withdraw_prove.sh', withdrawScript);
  run('bash /tmp/withdraw_prove.sh', WITHDRAW_CIRCUIT_DIR);
  
  const proofHex = extractProof(path.join(WITHDRAW_CIRCUIT_DIR, 'target/proof'), 2);
  console.log(`  Proof extracted (${proofHex.length} hex chars)`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, WHIRLWIND_ABI, wallet);

  const nullifier = id.toString();
  console.log(`  Nullifier: ${nullifier}`);

  console.log('\n  Submitting withdraw transaction...');
  const tx = await contract.withdraw(proofHex, nullifier);
  console.log(`  Tx hash: ${tx.hash}`);
  console.log('  Waiting for confirmation...');
  const receipt = await tx.wait();
  console.log(`  Confirmed in block ${receipt!.blockNumber}`);

  console.log('\n=== WITHDRAW COMPLETE ===\n');
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log(`
Whirlwind Mixer CLI
===================
Usage:
  npx tsx src/cli.ts sync                  Sync and display Merkle tree state
  npx tsx src/cli.ts deposit               Deposit 0.1 ETH into the mixer
  npx tsx src/cli.ts withdraw <index>      Withdraw 0.1 ETH for deposit at <index>

Environment variables:
  PRIVATE_KEY    Your wallet private key (0x...)
  RPC_URL        Sepolia RPC URL (default: https://ethereum-sepolia-rpc.publicnode.com)

Contract: ${CONTRACT_ADDRESS}
    `);
    return;
  }

  switch (command) {
    case 'sync': await syncTree(); break;
    case 'deposit': await doDeposit(); break;
    case 'withdraw': {
      const index = parseInt(args[1]);
      if (isNaN(index)) { console.error('Usage: npx tsx src/cli.ts withdraw <index>'); process.exit(1); }
      await doWithdraw(index);
      break;
    }
    default: console.error(`Unknown command: ${command}`); process.exit(1);
  }
}

main().catch((err) => { console.error('Error:', err); process.exit(1); });