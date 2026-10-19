'use strict'

const assert = require('assert/strict')
const { execFileSync } = require('child_process')
const fs = require('fs')
const Module = require('module')
const os = require('os')
const path = require('path')
const originalModuleLoad = Module._load

const protectedAuthorityRoot = fs.realpathSync('/home/ubuntu/projects/tbc-contract')
for (const method of ['appendFileSync', 'writeFileSync']) {
  const original = fs[method]
  fs[method] = function rejectAuthorityCheckoutWrite (file, ...args) {
    if (typeof file === 'string') {
      const relative = path.relative(protectedAuthorityRoot, path.resolve(file))
      assert.ok(
        relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
        `dependency regression test must not ${method} inside authority checkout: ${file}`
      )
    }
    return original.call(fs, file, ...args)
  }
}

const {
  assertCleanGitPaths,
  assertLoadedAuthorityClosure,
  CONTRACT_GIT_PATHS,
  CONTRACT_ROOT,
  SOURCE_FINGERPRINTS,
  TBC_ROOT
} = require('./pool-v2-js-165-dependencies')

const expectedContractOutputPaths = [
  'lib/contract/ft.js',
  'lib/contract/poolNFT2.0.js',
  'lib/util/ftunlock.js',
  'lib/util/poolnftunlock.js',
  'lib/util/util.js'
]

for (const relativePath of expectedContractOutputPaths) {
  assert.ok(
    CONTRACT_GIT_PATHS.includes(relativePath),
    `${relativePath} must be protected by the tracked-source dirty guard`
  )
  assert.ok(
    SOURCE_FINGERPRINTS.some(source =>
      source.component === 'tbc-contract' && source.path === relativePath
    ),
    `${relativePath} must have an exact source fingerprint`
  )
}

for (const relativePath of [
  'lib/address.js',
  'lib/privatekey.js',
  'lib/publickey.js',
  'lib/encoding/bufferwriter.js',
  'lib/crypto/bn.js',
  'lib/crypto/hash.js',
  'lib/crypto/hash.node.js'
]) {
  assert.ok(
    SOURCE_FINGERPRINTS.some(source =>
      source.component === 'tbc-lib-js' && source.path === relativePath
    ),
    `${relativePath} must have an exact resolved node_modules fingerprint`
  )
}

for (const unrelatedPath of [
  'lib/api/api.js',
  'lib/contract/nft.js'
]) {
  assert.ok(
    !SOURCE_FINGERPRINTS.some(source => source.path === unrelatedPath),
    `${unrelatedPath} is loaded incidentally but is not in the output call closure`
  )
}

for (const transactionAuthorityPath of [
  'lib/transaction/index.js',
  'lib/transaction/transaction.js',
  'lib/transaction/output.js',
  'lib/transaction/input/input.js',
  'lib/transaction/sighash.js',
  'lib/script/index.js',
  'lib/script/interpreter.js',
  'lib/crypto/ecdsa.js',
  'lib/crypto/schnorr.js'
]) {
  assert.ok(
    SOURCE_FINGERPRINTS.some(source =>
      source.component === 'tbc-lib-js' && source.path === transactionAuthorityPath
    ),
    `${transactionAuthorityPath} must be pinned because the eager Transaction facade executes it`
  )
}

for (const [component, relativePath] of [
  ['tbc-contract', 'index.js'],
  ['tbc-lib-js', 'index.js']
]) {
  assert.ok(
    !SOURCE_FINGERPRINTS.some(source =>
      source.component === component && source.path === relativePath
    ),
    `${component}:${relativePath} must not be fingerprinted when its index is not executed`
  )
}

for (const forbiddenLoadedPath of [
  path.join(CONTRACT_ROOT, 'index.js'),
  path.join(CONTRACT_ROOT, 'lib/api/api.js'),
  path.join(CONTRACT_ROOT, 'lib/contract/nft.js'),
  path.join(TBC_ROOT, 'index.js'),
  path.join(CONTRACT_ROOT, 'node_modules/elliptic/lib/elliptic.js')
]) {
  assert.equal(
    require.cache[forbiddenLoadedPath],
    undefined,
    `${forbiddenLoadedPath} must not execute while assembling fixture authority`
  )
}

const simulatedUnpinnedModule = path.join(CONTRACT_ROOT, 'lib/contract/nft.js')
require.cache[simulatedUnpinnedModule] = { filename: simulatedUnpinnedModule }
try {
  assert.throws(
    () => assertLoadedAuthorityClosure(),
    /unpinned loaded fixture authority module.*lib[/\\]contract[/\\]nft\.js/
  )
} finally {
  delete require.cache[simulatedUnpinnedModule]
}
assert.doesNotThrow(() => assertLoadedAuthorityClosure())

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-v2-authority-'))
try {
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Fixture Test'], { cwd: root })
  for (const relativePath of CONTRACT_GIT_PATHS) {
    const source = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(source), { recursive: true })
    fs.writeFileSync(source, `module.exports = ${JSON.stringify(relativePath)}\n`)
  }
  execFileSync('git', ['add', ...CONTRACT_GIT_PATHS], { cwd: root })
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root })

  assert.doesNotThrow(() => assertCleanGitPaths(root, CONTRACT_GIT_PATHS))

  fs.writeFileSync(path.join(root, 'unrelated.js'), 'ignored by scoped guard\n')
  assert.doesNotThrow(() => assertCleanGitPaths(root, CONTRACT_GIT_PATHS))

  for (const relativePath of expectedContractOutputPaths) {
    const source = path.join(root, relativePath)
    const original = fs.readFileSync(source)
    fs.appendFileSync(source, '// tampered\n')
    assert.throws(
      () => assertCleanGitPaths(root, CONTRACT_GIT_PATHS),
      new RegExp(`dirty authority file.*${relativePath.replaceAll('/', '[\\\\/]')}`)
    )
    fs.writeFileSync(source, original)
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

const generatorPath = path.join(__dirname, 'generate-pool-v2-js-fixtures.js')
const generatorOptions = {
  cwd: path.join(__dirname, '..'),
  maxBuffer: 4 * 1024 * 1024
}
const cleanGenerated = execFileSync(process.execPath, [generatorPath], generatorOptions)
const nftPath = path.join(CONTRACT_ROOT, 'lib/contract/nft.js')
const contractIndexPath = path.join(CONTRACT_ROOT, 'index.js')
const scriptEntryPath = path.join(TBC_ROOT, 'lib/script/script.js')
const injectedNftAttack = `
'use strict'
const assert = require('assert/strict')
const fs = require('fs')
const Module = require('module')
const targetNft = fs.realpathSync(${JSON.stringify(nftPath)})
const targetScript = fs.realpathSync(${JSON.stringify(scriptEntryPath)})
const originalLoad = Module._load
let attackTriggered = false
Module._load = function injectedNftSideEffect(request, parent, isMain) {
  let resolved
  try {
    resolved = fs.realpathSync(Module._resolveFilename(request, parent, isMain))
  } catch (_) {}
  const exported = originalLoad.call(this, request, parent, isMain)
  if (!attackTriggered && resolved === targetNft) {
    const Script = originalLoad.call(this, targetScript, module, false)
    const originalToBuffer = Script.prototype.toBuffer
    Script.prototype.toBuffer = function attackedToBuffer() {
      const bytes = originalToBuffer.call(this)
      const attacked = Buffer.from(bytes)
      if (attacked.length !== 0) attacked[0] ^= 0x01
      return attacked
    }
    attackTriggered = true
  }
  return exported
}
if (process.argv[1] === 'probe') {
  const Script = require(targetScript)
  const before = Script.fromHex('51').toBuffer()
  require(${JSON.stringify(contractIndexPath)})
  assert.equal(attackTriggered, true, 'public contract index must load nft.js in the attack probe')
  assert.notDeepEqual(Script.fromHex('51').toBuffer(), before, 'loaded nft.js attack must pollute Script.toBuffer')
} else {
  require(process.argv[1])
  assert.equal(attackTriggered, false, 'fixture generator must not load public index/nft.js')
}
`
execFileSync(process.execPath, ['-e', injectedNftAttack, 'probe'], generatorOptions)
const attackedGenerated = execFileSync(
  process.execPath,
  ['-e', injectedNftAttack, generatorPath],
  generatorOptions
)
assert.deepEqual(
  attackedGenerated,
  cleanGenerated,
  'an injected nft.js side effect must not mutate fixture output when public indexes stay unloaded'
)

assert.strictEqual(
  Module._load,
  originalModuleLoad,
  'dependency helper must restore the exact Module._load object before returning'
)
