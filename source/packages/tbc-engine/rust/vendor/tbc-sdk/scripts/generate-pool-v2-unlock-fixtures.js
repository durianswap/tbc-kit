'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const {
  CONTRACT_PACKAGE,
  PoolNFT2,
  TBC_PACKAGE,
  CONTRACT_ROOT,
  tbc
} = require('./pool-v2-js-165-dependencies')

const {
  getCurrentTxOutputsDataforPool2,
  getInputsTxdata,
  getInputsTxdataSwap,
  getCurrentInputsdata,
  getPoolNFTPreTxdata,
  getPoolNFTPrePreTxdata
} = require(path.join(CONTRACT_ROOT, 'lib/util/poolnftunlock.js'))

const scriptFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../tests/fixtures/pool-v2-js-165.json'), 'utf8')
)
const sourceAuthority = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../tests/fixtures/pool-v2-source-authority.json'), 'utf8')
)

function addOutput (transaction, satoshis, scriptHex) {
  transaction.addOutput(new tbc.Transaction.Output({
    satoshis,
    script: scriptHex
  }))
  return transaction
}

function transactionFrom (txid, vout, scriptHex, satoshis, outputs, lockTime) {
  const transaction = new tbc.Transaction().from({
    txId: txid,
    outputIndex: vout,
    script: scriptHex,
    satoshis
  })
  transaction.version = 10
  transaction.nLockTime = lockTime
  for (const output of outputs) {
    addOutput(transaction, output.satoshis, output.script)
  }
  return transaction
}

function txid (transaction) {
  return transaction.id
}

function raw (transaction) {
  return transaction.uncheckedSerialize()
}

function p2pkhScript (fill) {
  return tbc.Script.buildPublicKeyHashOut(
    tbc.Address.fromPublicKeyHash(Buffer.alloc(20, fill))
  ).toHex()
}

function amountSlots (amountRaw) {
  const writer = new tbc.encoding.BufferWriter()
  writer.writeUInt64LEBN(new tbc.crypto.BN(amountRaw.toString()))
  for (let index = 1; index < 6; index++) {
    writer.writeUInt64LEBN(new tbc.crypto.BN(0))
  }
  return writer.toBuffer()
}

function standardTape81 () {
  const name = 'ABCDEFGHIJKLMNO'
  const symbol = 'PQRST'
  const tape = tbc.Script.fromASM(
    `OP_FALSE OP_RETURN ${amountSlots(42_000_000).toString('hex')} ` +
    `06 ${Buffer.from(name).toString('hex')} ${Buffer.from(symbol).toString('hex')} 4654617065`
  )
  if (tape.toBuffer().length !== 81) {
    throw new Error(`expected 81-byte source FTLP Tape, got ${tape.toBuffer().length}`)
  }
  return tape
}

function lockTimeTape81 () {
  const writer = new tbc.encoding.BufferWriter()
  writer.writeUInt32LE(1_750_000_000)
  const tape = tbc.Script.fromASM(
    `OP_FALSE OP_RETURN ${amountSlots(42_000_000).toString('hex')} ` +
    `${writer.toBuffer().toString('hex')} ${'OP_0 '.repeat(19)}4654617065`
  )
  if (tape.toBuffer().length !== 81) {
    throw new Error(`expected 81-byte lock-time FTLP Tape, got ${tape.toBuffer().length}`)
  }
  return tape
}

const scripts = scriptFixture.scripts
const standardPool = scripts.standardPool.hex
const lockedPool = scripts.lockedPoolOneKey.hex
const poolTape = scripts.poolTape.hex
const ftCode = scripts.poolHeldFt.hex
const ftlpCode = scripts.currentFtlp.hex
const lockTimeFtlpCode = scripts.lockTimeFtlp.hex
const sourceTape = standardTape81().toHex()
const lockTimeTape = lockTimeTape81().toHex()
const ownerScript = p2pkhScript(0x44)
const lockScript = p2pkhScript(0x77)
const privateKey = new tbc.PrivateKey('01'.repeat(32), 'mainnet')
const pool = new PoolNFT2()

// Released Pool serializers classify FT families by these exact script sizes.
// Keep the v1 suffix while deriving the legacy-size fixture from released v3
// code. The real v2/Coin scripts are the minimal public authority committed in
// this repo, so regeneration never depends on a tx-parser sibling checkout.
// Distinct current FT, current FTLP, and lock-time FTLP scripts stay in the
// matrix even where the released serializer deliberately shares the 1884-byte
// branch.
function legacyV1Code (releasedV3Hex) {
  const code = Buffer.from(releasedV3Hex, 'hex')
  const legacy = Buffer.concat([code.subarray(0, 1536), code.subarray(code.length - 28)])
  if (legacy.length !== 1564 || !legacy.subarray(-5).equals(Buffer.from('2Code'))) {
    throw new Error('failed to derive the released 1564-byte FT v1 serialization fixture')
  }
  return legacy.toString('hex')
}

const AUTHORITY_REPOSITORY = 'https://github.com/LoongYearMeta/tx-parser.git'
const AUTHORITY_COMMIT = 'aa846515acbd41f51a0379e9c0c7e0c0cce5195d'
const authorityExpectations = {
  ftV2: {
    contractFamily: 'FT v2',
    sourceFixture: 'tests/fixtures/order-book/input-utxo-cache.json',
    sourceFixtureSha256: 'd3a972290eaed64c7f97504b679e4c7ac3d70d7f8e261d2ea5b4d66a6bb73153',
    byteLength: 1884,
    scriptSha256: 'd116c3bd36d758059cf5df6c0d80446ac427caf7b15d7078548dfb81f8e0a8f8'
  },
  coin: {
    contractFamily: 'Coin',
    sourceFixture: 'tests/fixtures/stablecoin/input-utxo-cache.json',
    sourceFixtureSha256: '584143098e5fde271a595b0db37a7763a2eb2386af3279eb480f8b6362866b3e',
    byteLength: 2012,
    scriptSha256: '3d87a7f0a408d17f22cee1da3d1bbeaa13ffa455e43b8c7dd1339e8f973095c6'
  }
}

function authorityCode (key, predicate) {
  if (sourceAuthority.schemaVersion !== 1 ||
      sourceAuthority.provenance?.repository !== AUTHORITY_REPOSITORY ||
      sourceAuthority.provenance?.commit !== AUTHORITY_COMMIT) {
    throw new Error('unexpected Pool v2 source authority provenance/version')
  }
  const record = sourceAuthority.scripts?.[key]
  const expected = authorityExpectations[key]
  for (const field of [
    'contractFamily',
    'sourceFixture',
    'sourceFixtureSha256',
    'byteLength',
    'scriptSha256'
  ]) {
    if (record?.[field] !== expected[field]) {
      throw new Error(`unexpected ${key} authority ${field}`)
    }
  }
  if (typeof record.hex !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(record.hex)) {
    throw new Error(`invalid ${key} authority hex`)
  }
  const bytes = Buffer.from(record.hex, 'hex')
  const digest = crypto.createHash('sha256').update(bytes).digest('hex')
  if (bytes.length !== expected.byteLength || digest !== expected.scriptSha256 ||
      !bytes.subarray(-5).equals(Buffer.from('2Code')) || !predicate(record.hex)) {
    throw new Error(`invalid ${key} authority script bytes`)
  }
  return record.hex
}

const ftV1Code = legacyV1Code(ftCode)
const ftV2Code = authorityCode('ftV2', codeHex => {
  const chunks = tbc.Script.fromHex(codeHex).chunks
  return ![0x5f, 0x02].includes(chunks[chunks.length - 5]?.opcodenum)
})
const coinCode = authorityCode('coin', () => true)

const sourceFamilies = [
  { kind: 'ft-v1', code: ftV1Code, tape: sourceTape },
  { kind: 'ft-v2', code: ftV2Code, tape: sourceTape },
  { kind: 'ft-current', code: ftCode, tape: sourceTape },
  { kind: 'coin', code: coinCode, tape: sourceTape },
  { kind: 'ftlp-current', code: ftlpCode, tape: sourceTape },
  { kind: 'ftlp-locktime', code: lockTimeFtlpCode, tape: lockTimeTape }
]

function ancestry (poolCodeHex, seed) {
  const prePre = transactionFrom(
    seed.repeat(32),
    0,
    ownerScript,
    80_000_000,
    [
      { satoshis: 30_001_000, script: poolCodeHex },
      { satoshis: 0, script: poolTape },
      { satoshis: 49_998_920, script: ownerScript }
    ],
    11
  )
  const pre = transactionFrom(
    txid(prePre),
    0,
    poolCodeHex,
    30_001_000,
    [
      { satoshis: 30_001_000, script: poolCodeHex },
      { satoshis: 0, script: poolTape }
    ],
    12
  )
  return { prePre, pre }
}

function auxiliaryParent (seed, family) {
  return transactionFrom(
    seed.repeat(32),
    1,
    ownerScript,
    100_000,
    [
      { satoshis: 500, script: family.code },
      { satoshis: 0, script: family.tape },
      { satoshis: 99_420, script: ownerScript }
    ],
    13
  )
}

function operationOutputs (poolCodeHex, withLock, option, swapOption) {
  const outputs = [
    { satoshis: 30_101_000, script: poolCodeHex },
    { satoshis: 0, script: poolTape }
  ]
  if (option === 1) {
    outputs.push(
      { satoshis: 500, script: ftCode },
      { satoshis: 0, script: sourceTape },
      { satoshis: 500, script: ftlpCode },
      { satoshis: 0, script: lockTimeTape }
    )
    if (withLock) outputs.push({ satoshis: 1_250_000, script: lockScript })
  } else if (option === 2) {
    // output[2] intentionally uses v1 while the FTLP marker branch at output[7]
    // reuses its outer offset, matching the released JS 1.6.5 quirk.
    outputs.push(
      { satoshis: 500, script: ftV1Code },
      { satoshis: 0, script: sourceTape },
      { satoshis: 700_000, script: ownerScript },
      { satoshis: 500, script: ftlpCode },
      { satoshis: 0, script: lockTimeTape },
      { satoshis: 500, script: ftlpCode },
      { satoshis: 0, script: lockTimeTape },
      { satoshis: 8_000, script: ownerScript }
    )
  } else if (option === 3 && swapOption === 1) {
    outputs.push(
      { satoshis: 500, script: ftCode },
      { satoshis: 0, script: sourceTape },
      { satoshis: 500, script: coinCode },
      { satoshis: 0, script: sourceTape },
      { satoshis: 500, script: ftV1Code },
      { satoshis: 0, script: sourceTape }
    )
  } else if (option === 3 && swapOption === 2) {
    outputs.push(
      { satoshis: 500, script: ftCode },
      { satoshis: 0, script: sourceTape },
      { satoshis: 700_000, script: ownerScript },
      { satoshis: 500, script: lockTimeFtlpCode },
      { satoshis: 0, script: lockTimeTape },
      { satoshis: 500, script: coinCode },
      { satoshis: 0, script: sourceTape }
    )
  } else if (option === 4) {
    outputs.push(
      { satoshis: 500, script: ftCode },
      { satoshis: 0, script: sourceTape },
      { satoshis: 8_000, script: ownerScript }
    )
  } else {
    throw new Error(`unsupported option=${option} swapOption=${swapOption}`)
  }
  return outputs
}

function currentTransaction (poolCodeHex, chain, inputParents, outputs) {
  const transaction = new tbc.Transaction().from({
    txId: txid(chain.pre),
    outputIndex: 0,
    script: poolCodeHex,
    satoshis: 30_001_000
  })
  for (const inputParent of inputParents) {
    transaction.from({
      txId: txid(inputParent),
      outputIndex: 0,
      script: inputParent.outputs[0].script.toHex(),
      satoshis: inputParent.outputs[0].satoshis
    })
  }
  transaction.version = 10
  transaction.nLockTime = 14
  for (const output of outputs) addOutput(transaction, output.satoshis, output.script)
  return transaction
}

function contractTransaction (seed) {
  return transactionFrom(
    seed.repeat(32),
    0,
    ownerScript,
    1_000_000,
    [
      { satoshis: 500, script: ftCode },
      { satoshis: 0, script: sourceTape }
    ],
    10
  )
}

function lockedKeys (poolCodeHex) {
  return tbc.Script.fromHex(poolCodeHex).chunks
    .filter(chunk => chunk.buf && chunk.buf.length === 33)
    .map(chunk => chunk.buf.toString('hex'))
    .sort()
}

function vector (name, poolCodeHex, poolLocked, withLock, option, swapOption, seed) {
  const chain = ancestry(poolCodeHex, seed)
  const inputParents = sourceFamilies.map((family, index) => {
    const inputSeed = (parseInt(seed, 16) + index + 1).toString(16).padStart(2, '0')
    return auxiliaryParent(inputSeed, family)
  })
  const outputs = operationOutputs(poolCodeHex, withLock, option, swapOption)
  const current = currentTransaction(poolCodeHex, chain, inputParents, outputs)
  const contract = contractTransaction(
    (parseInt(seed, 16) + 10).toString(16).padStart(2, '0')
  )
  const unlock = pool.getPoolNftUnlockOffLine(
    privateKey,
    current,
    0,
    chain.pre,
    chain.prePre,
    inputParents,
    withLock,
    option,
    swapOption
  ).toBuffer().toString('hex')
  return {
    name,
    option,
    swapOption: swapOption ?? null,
    locked: Boolean(poolLocked),
    withLock: Boolean(withLock),
    currentRaw: raw(current),
    poolPreRaw: raw(chain.pre),
    poolPrePreRaw: raw(chain.prePre),
    contractRaw: raw(contract),
    contractTxid: txid(contract),
    inputParentKinds: sourceFamilies.map(family => family.kind),
    inputParentRaws: inputParents.map(raw),
    unlockHex: unlock,
    currentInputsHex: getCurrentInputsdata(current),
    inputParentDataHex: inputParents.map(parent => option === 3
      ? getInputsTxdataSwap(parent, 0)
      : getInputsTxdata(parent, 0)),
    poolPreDataHex: getPoolNFTPreTxdata(chain.pre),
    poolPrePreDataHex: getPoolNFTPrePreTxdata(chain.prePre),
    outputsDataHex: getCurrentTxOutputsDataforPool2(current, option, withLock, swapOption),
    poolPublicKeys: lockedKeys(poolCodeHex),
    signingPublicKey: privateKey.toPublicKey().toString(),
    signatureHex: current.getSignature(0, privateKey)
  }
}

const operations = [
  { key: 'option1', option: 1 },
  { key: 'option2', option: 2 },
  { key: 'option3Swap1', option: 3, swapOption: 1 },
  { key: 'option3Swap2', option: 3, swapOption: 2 },
  { key: 'option4', option: 4 }
]

const vectors = {}
let seed = 0x41
for (const operation of operations) {
  for (const mode of [
    { key: 'standard', code: standardPool, poolLocked: 0, withLock: 0 },
    { key: 'locked', code: lockedPool, poolLocked: 1, withLock: 1 }
  ]) {
    const name = `${operation.key}_${mode.key}`
    vectors[name] = vector(
      name,
      mode.code,
      mode.poolLocked,
      mode.withLock,
      operation.option,
      operation.swapOption,
      seed.toString(16).padStart(2, '0')
    )
    seed += 0x10
  }
}
vectors.option1_locked_init = vector(
  'option1_locked_init',
  lockedPool,
  1,
  0,
  1,
  undefined,
  seed.toString(16).padStart(2, '0')
)

const fixture = {
  contractName: CONTRACT_PACKAGE.name,
  contractVersion: CONTRACT_PACKAGE.version,
  tbcLibVersion: TBC_PACKAGE.version,
  sourceAuthority: {
    schemaVersion: sourceAuthority.schemaVersion,
    repository: sourceAuthority.provenance.repository,
    commit: sourceAuthority.provenance.commit,
    scripts: Object.fromEntries(Object.entries(authorityExpectations).map(([key, value]) => [
      key,
      value
    ]))
  },
  sourceTapeHex: sourceTape,
  sourceTapeBytes: Buffer.from(sourceTape, 'hex').length,
  lockTimeTapeHex: lockTimeTape,
  lockTimeTapeBytes: Buffer.from(lockTimeTape, 'hex').length,
  sourceFamilyLengths: {
    'ft-v1': Buffer.from(ftV1Code, 'hex').length,
    'ft-v2': Buffer.from(ftV2Code, 'hex').length,
    'ft-current': Buffer.from(ftCode, 'hex').length,
    coin: Buffer.from(coinCode, 'hex').length,
    'ftlp-current': Buffer.from(ftlpCode, 'hex').length,
    'ftlp-locktime': Buffer.from(lockTimeFtlpCode, 'hex').length
  },
  lockedThreePoolHex: scripts.lockedPoolThreeKeys.hex,
  lockedThreePoolPublicKeys: lockedKeys(scripts.lockedPoolThreeKeys.hex),
  vectors
}

process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`)
