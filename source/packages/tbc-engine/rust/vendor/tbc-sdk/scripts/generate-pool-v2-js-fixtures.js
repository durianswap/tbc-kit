'use strict'

const crypto = require('crypto')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const {
  assertLoadedAuthorityClosure,
  CONTRACT_PACKAGE,
  CONTRACT_ROOT,
  DEPENDENCY_HELPER_PATH,
  FT,
  PoolNFT2,
  SDK_ROOT,
  SOURCE_FINGERPRINTS,
  TBC_PACKAGE,
  sha256File,
  tbc
} = require('./pool-v2-js-165-dependencies')

const GO_COMMIT = 'fea64e67eedec31f014292e39ebbbee368d7edb3'
const CONTRACT_COMMIT = '19acaa0e279c39741c9957e1236b3eac9ff4154a'
const DEPENDENCY_HELPER_SHA256 = '1db57011bd469e7384cdde1bcdd632ff598982c1edb5e5521957a0d397a2d374'
const GO_ROOT = fs.realpathSync('/home/ubuntu/projects/tbc-contract-go')
const TEMPLATE_SOURCES = {
  'poolnft2_code.asm': '4b4ea776d5657dacacc27b18cfaf7e44f9a7f9defff4c4116e9ef3e22d56d55a',
  'poolnft2_lock_code_pre.asm': 'cb35426428e8a145da37594485ddca7407e66855cd4eb84d4f30353c4a06e946',
  'poolnft2_lock_code_last.asm': '7429997c94d8ad0573e239fdc6cf5a8ebe210b34c772c0f720c6c35c31619808',
  'poolnft2_ftlp_code.asm': '18478f9753f655df20cbffc74c05ca335a708a600c3c5787299af9976643f44b',
  'poolnft2_ftlp_locktime_code.asm': 'c9eadf3a9d6984f19b957fe52f84f2d01e72e3cdc0769d1d9d42e212c03cc6bf'
}

function assertInside (candidate, root, label) {
  const relative = path.relative(root, candidate)
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must resolve inside ${root}, got ${candidate}`)
  }
}

function sha256 (bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

const expectedDependencyHelper = fs.realpathSync(
  path.join(SDK_ROOT, 'scripts/pool-v2-js-165-dependencies.js')
)
if (DEPENDENCY_HELPER_PATH !== expectedDependencyHelper) {
  throw new Error(`fixture generator resolved a different dependency helper: ${DEPENDENCY_HELPER_PATH}`)
}
const dependencyHelperSha256 = sha256File(DEPENDENCY_HELPER_PATH)
if (dependencyHelperSha256 !== DEPENDENCY_HELPER_SHA256) {
  throw new Error(
    `fixture dependency helper SHA-256 mismatch: expected ${DEPENDENCY_HELPER_SHA256}, got ${dependencyHelperSha256}`
  )
}
const sourceFingerprints = [
  ...SOURCE_FINGERPRINTS,
  {
    component: 'tbc-sdk',
    path: 'scripts/pool-v2-js-165-dependencies.js',
    sha256: dependencyHelperSha256
  }
]

const templateAssets = Object.entries(TEMPLATE_SOURCES).map(([name, expectedSha256]) => {
  const source = fs.realpathSync(path.join(GO_ROOT, 'lib/contract/asm', name))
  assertInside(source, GO_ROOT, `released Go template ${name}`)
  const bytes = fs.readFileSync(source)
  const actualSha256 = sha256(bytes)
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `released Go template ${name} SHA-256 mismatch: ${actualSha256}`
    )
  }
  return {
    path: `lib/contract/asm/${name}`,
    sha256: actualSha256
  }
})

function scriptFixture (script) {
  const bytes = script.toBuffer()
  return {
    hex: bytes.toString('hex'),
    length: bytes.length,
    sha256: sha256(bytes)
  }
}

function publicKeyForRepeatedScalarByte (value) {
  const scalarHex = value.toString(16).padStart(2, '0').repeat(32)
  return new tbc.PrivateKey(scalarHex, 'mainnet').toPublicKey().toString()
}

const actualContractCommit = execFileSync(
  'git',
  ['-C', CONTRACT_ROOT, 'rev-parse', 'HEAD'],
  { encoding: 'utf8' }
).trim()
if (actualContractCommit !== CONTRACT_COMMIT) {
  throw new Error(
    `expected tbc-contract commit ${CONTRACT_COMMIT}, got ${actualContractCommit}`
  )
}

function amountSlots (amountRaw) {
  const writer = new tbc.encoding.BufferWriter()
  writer.writeUInt64LEBN(new tbc.crypto.BN(amountRaw.toString()))
  for (let index = 1; index < 6; index++) {
    writer.writeUInt64LEBN(new tbc.crypto.BN(0))
  }
  return writer.toBuffer()
}

function standardFtlpTape (amountRaw, decimal, name, symbol, isCoin) {
  const chunks = [
    'OP_FALSE',
    'OP_RETURN',
    amountSlots(amountRaw).toString('hex'),
    decimal.toString(16).padStart(2, '0'),
    Buffer.from(name, 'utf8').toString('hex'),
    Buffer.from(symbol, 'utf8').toString('hex')
  ]
  if (isCoin) chunks.push('00000000')
  chunks.push('4654617065')
  return tbc.Script.fromASM(chunks.join(' '))
}

function lockTimeFtlpTape (amountRaw, lockTime, sourceFtTapeSize) {
  const lockTimeWriter = new tbc.encoding.BufferWriter()
  lockTimeWriter.writeUInt32LE(lockTime)
  const fillSize = sourceFtTapeSize - 62
  if (fillSize < 0) throw new Error('source FT tape is shorter than 62 bytes')
  return tbc.Script.fromASM(
    `OP_FALSE OP_RETURN ${amountSlots(amountRaw).toString('hex')} ` +
    `${lockTimeWriter.toBuffer().toString('hex')} ` +
    `${'OP_0 '.repeat(fillSize)}4654617065`
  )
}

const sourceTxid = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
const sourceVout = 7
const tag = 'parity'
const tagHex = Buffer.from(tag, 'utf8').toString('hex')
const publicKeys = Array.from({ length: 10 }, (_, index) => index + 1)
  .map(publicKeyForRepeatedScalarByte)
if (!publicKeys.every(key => key.length === 66 && /^(02|03)/.test(key))) {
  throw new Error('fixture locked Pool keys must all be compressed public keys')
}
const canonicalPublicKeys = [...publicKeys].sort()
const owner = new tbc.PrivateKey('09'.repeat(32), 'mainnet').toAddress()
const lpCostAddress = tbc.Address.fromPublicKeyHash(Buffer.alloc(20, 0x77))
const lpCostSat = 1_250_000
const ftName = 'Token'
const ftSymbol = 'TOK'
const ftDecimal = 6
const ftlpAmountRaw = 42_000_000

const pool = new PoolNFT2()
pool.ft_lp_amount = 30_000_000n
pool.ft_a_amount = 100_000_000n
pool.tbc_amount = 30_000_000n
pool.ft_lp_partialhash = '11'.repeat(32)
pool.ft_a_partialhash = '22'.repeat(32)
pool.ft_a_contractTxid = '33'.repeat(32)
pool.service_fee_rate = 35

const ftlpTape = standardFtlpTape(
  ftlpAmountRaw,
  ftDecimal,
  ftName,
  ftSymbol,
  false
)
const ftTapeSize = ftlpTape.toBuffer().length
const ftlpLockTimeTape = lockTimeFtlpTape(
  ftlpAmountRaw,
  1_750_000_000,
  ftTapeSize
)
if (ftlpLockTimeTape.toBuffer().length !== ftTapeSize) {
  throw new Error('lock-time FTLP tape does not preserve source FT tape byte length')
}

const standardPool = pool.getPoolNftCode(
  sourceTxid,
  sourceVout,
  1,
  3,
  tag,
  false
)
if (standardPool.toBuffer().length > 3300) {
  throw new Error('fixture unlocked Pool crossed the released lock discriminator')
}
const lockedPoolOneKey = pool.getPoolNftCodeWithLock(
  sourceTxid,
  sourceVout,
  1,
  lpCostAddress,
  lpCostSat / 1_000_000,
  publicKeys.slice(0, 1),
  3,
  tag,
  false
)
const lockedPoolTwoKeys = pool.getPoolNftCodeWithLock(
  sourceTxid,
  sourceVout,
  1,
  lpCostAddress,
  lpCostSat / 1_000_000,
  [...publicKeys.slice(0, 2)].sort(),
  3,
  tag,
  false
)
const lockedPoolThreeKeys = pool.getPoolNftCodeWithLock(
  sourceTxid,
  sourceVout,
  1,
  lpCostAddress,
  lpCostSat / 1_000_000,
  [...publicKeys.slice(0, 3)].sort(),
  3,
  tag,
  false
)
const lockedPoolTenKeys = pool.getPoolNftCodeWithLock(
  sourceTxid,
  sourceVout,
  1,
  lpCostAddress,
  lpCostSat / 1_000_000,
  canonicalPublicKeys,
  3,
  tag,
  false
)
for (const invalidKeys of [[], [...publicKeys, publicKeyForRepeatedScalarByte(11)]]) {
  let rejected = false
  try {
    pool.getPoolNftCodeWithLock(
      sourceTxid,
      sourceVout,
      1,
      lpCostAddress,
      lpCostSat / 1_000_000,
      invalidKeys,
      3,
      tag,
      false
    )
  } catch (error) {
    rejected = /1 to 10 elements/.test(error.message)
  }
  if (!rejected) throw new Error(`JS 1.6.5 accepted ${invalidKeys.length} locked Pool keys`)
}

const poolCodeHash = tbc.crypto.Hash.sha256(standardPool.toBuffer())
const currentFtlp = pool.getFtlpCode(
  poolCodeHash.toString('hex'),
  owner.toString(),
  ftTapeSize,
  false,
  3
)
const lockTimeFtlp = pool.getFtlpCodeWithLockTime(
  poolCodeHash.toString('hex'),
  owner.toString(),
  ftTapeSize,
  false,
  3
)
const legacyV2Ftlp = pool.getFtlpCode(
  poolCodeHash.toString('hex'),
  owner.toString(),
  ftTapeSize,
  false,
  2
)
const legacyV2LockTimeFtlp = pool.getFtlpCodeWithLockTime(
  poolCodeHash.toString('hex'),
  owner.toString(),
  ftTapeSize,
  false,
  2
)

const ft = new FT({ name: ftName, symbol: ftSymbol, amount: 42, decimal: ftDecimal })
const ftCode = ft.getFTmintCode(sourceTxid, sourceVout, owner.toString(), ftTapeSize)
if (ftCode.toBuffer().length !== 1884) {
  throw new Error(`expected current regular FT code to be 1884 bytes, got ${ftCode.toBuffer().length}`)
}
const poolHeldFt = FT.buildFTtransferCode(
  ftCode.toBuffer().toString('hex'),
  '55'.repeat(20)
)

const poolTape = pool.getPoolNftTape(1, true, true)
const fixture = {
  contractName: CONTRACT_PACKAGE.name,
  contractVersion: CONTRACT_PACKAGE.version,
  contractCommit: actualContractCommit,
  tbcLibVersion: TBC_PACKAGE.version,
  sourceFingerprints,
  goTemplateCommit: GO_COMMIT,
  templateAssets,
  sourceTxid,
  sourceVout,
  tagHex,
  ownerHash160: owner.hashBuffer.toString('hex'),
  lpCostHash160: lpCostAddress.hashBuffer.toString('hex'),
  lpCostSat,
  ftTapeSize,
  ftName,
  ftSymbol,
  publicKeys,
  ftCodeHex: ftCode.toBuffer().toString('hex'),
  poolCodeHash: poolCodeHash.toString('hex'),
  state: {
    ftLpRaw: Number(pool.ft_lp_amount),
    ftARaw: Number(pool.ft_a_amount),
    tbcSat: Number(pool.tbc_amount),
    ftLpPartialHash: pool.ft_lp_partialhash,
    ftAPartialHash: pool.ft_a_partialhash,
    ftAContractId: pool.ft_a_contractTxid,
    serviceFeeRate: pool.service_fee_rate,
    lpPlan: 1,
    publicKeyLocked: true,
    ftlpLockTimeEnabled: true
  },
  scripts: {
    standardPool: scriptFixture(standardPool),
    lockedPoolOneKey: scriptFixture(lockedPoolOneKey),
    lockedPoolTwoKeys: scriptFixture(lockedPoolTwoKeys),
    lockedPoolThreeKeys: scriptFixture(lockedPoolThreeKeys),
    lockedPoolTenKeys: scriptFixture(lockedPoolTenKeys),
    currentFtlp: scriptFixture(currentFtlp),
    lockTimeFtlp: scriptFixture(lockTimeFtlp),
    legacyV2Ftlp: scriptFixture(legacyV2Ftlp),
    legacyV2LockTimeFtlp: scriptFixture(legacyV2LockTimeFtlp),
    poolTape: scriptFixture(poolTape),
    poolHeldFt: scriptFixture(poolHeldFt),
    ftlpTape: scriptFixture(ftlpTape),
    ftlpLockTimeTape: scriptFixture(ftlpLockTimeTape)
  }
}

assertLoadedAuthorityClosure()
process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`)
