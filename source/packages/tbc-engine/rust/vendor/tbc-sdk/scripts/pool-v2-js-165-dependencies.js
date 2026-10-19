'use strict'

const crypto = require('crypto')
const { execFileSync } = require('child_process')
const fs = require('fs')
const Module = require('module')
const { createRequire } = Module
const path = require('path')

const EXPECTED_CONTRACT_ROOT = '/home/ubuntu/projects/tbc-contract'
const CONTRACT_ROOT = fs.realpathSync(EXPECTED_CONTRACT_ROOT)
const CONTRACT_NODE_MODULES_ROOT = fs.realpathSync(path.join(CONTRACT_ROOT, 'node_modules'))
const TBC_ROOT = fs.realpathSync(path.join(CONTRACT_NODE_MODULES_ROOT, 'tbc-lib-js'))
const SDK_ROOT = fs.realpathSync(path.join(__dirname, '..'))

const COMPONENT_ROOTS = Object.freeze({
  'tbc-contract': CONTRACT_ROOT,
  'tbc-lib-js': TBC_ROOT,
  elliptic: fs.realpathSync(path.join(CONTRACT_NODE_MODULES_ROOT, 'elliptic')),
  'elliptic-inherits': fs.realpathSync(path.join(CONTRACT_NODE_MODULES_ROOT, 'elliptic/node_modules/inherits')),
  'bn.js': fs.realpathSync(path.join(CONTRACT_NODE_MODULES_ROOT, 'bn.js')),
  brorand: fs.realpathSync(path.join(CONTRACT_NODE_MODULES_ROOT, 'brorand')),
  'hash.js': fs.realpathSync(path.join(CONTRACT_NODE_MODULES_ROOT, 'hash.js')),
  'hmac-drbg': fs.realpathSync(path.join(CONTRACT_NODE_MODULES_ROOT, 'hmac-drbg')),
  inherits: fs.realpathSync(path.join(CONTRACT_NODE_MODULES_ROOT, 'inherits')),
  'minimalistic-assert': fs.realpathSync(path.join(CONTRACT_NODE_MODULES_ROOT, 'minimalistic-assert')),
  'minimalistic-crypto-utils': fs.realpathSync(path.join(CONTRACT_NODE_MODULES_ROOT, 'minimalistic-crypto-utils')),
  bs58: fs.realpathSync(path.join(CONTRACT_NODE_MODULES_ROOT, 'bs58')),
  'base-x': fs.realpathSync(path.join(CONTRACT_NODE_MODULES_ROOT, 'base-x')),
  'safe-buffer': fs.realpathSync(path.join(CONTRACT_NODE_MODULES_ROOT, 'safe-buffer'))
})

// The generator never executes either package's public index. Contract modules
// receive a direct-module tbc facade, so this table can pin the complete loaded
// dependency graph without inheriting unrelated eager public exports.
const SOURCE_SPECS = Object.freeze([
  ['tbc-contract', 'package.json', 'f73d7e15985eff6a3ad052f151e9880113a0935caf6ef7b3e056c9d85f4a4182'],
  ['tbc-contract', 'package-lock.json', '76f8d1d2643341329d6f70c5a2daa5d7a3148fe53482f219db8f655ecd6ba941'],
  ['tbc-contract', 'lib/contract/ft.js', 'e8187c94694becaae85788eab0c529838e3e10119782ade4eb5599ed9622b100'],
  ['tbc-contract', 'lib/contract/poolNFT2.0.js', 'ee05cab9f90e99203e3c893fa2729cb840cf22da11a4ea76157a88a7cf9c18db'],
  ['tbc-contract', 'lib/util/ftunlock.js', '731bd16b7ca8d657c897365d514c027bdc3c189dad8e4892c54de028ecc8633d'],
  ['tbc-contract', 'lib/util/poolnftunlock.js', '85ae94ec9dfeb22616b69caccbeabce248f7954990ed9501e4f0e64f2da4109b'],
  ['tbc-contract', 'lib/util/util.js', 'dce905f646f7e2f99a54fb7518b5e18ca414487040ae0aec2c981560441696b2'],
  ['tbc-lib-js', 'package.json', '4a193a2bdb50f00f8617d18257ac25aa3bf69e2b7fc29a307c5055af6aadca6e'],
  ['tbc-lib-js', 'lib/address.js', '263ab3d2e8968d2b6af365a2b0ba008f85e27194652745a829d791bd4d1c16fc'],
  ['tbc-lib-js', 'lib/bn.js', '81f2a08a2921161d755f4f04cab0e1cbfe727f59988391bb6d71c16a0c3c5a39'],
  ['tbc-lib-js', 'lib/crypto/bn.js', 'df858647b82e9fd68be1614ed1d4b816610f94ce6e55782593d8e58e9083734e'],
  ['tbc-lib-js', 'lib/crypto/ecdsa.js', 'a9910c9b149be402d4f59e2f699251e0b62ef18e2da460f9d1e44a21fe9a6ce7'],
  ['tbc-lib-js', 'lib/crypto/hash.js', 'd22d2e725e3a0a305d1c3e5e5b9c5bd9d19a668b7632b27e7b12fe74cdd2e6af'],
  ['tbc-lib-js', 'lib/crypto/hash.node.js', '92a9b829ecb8142141040b6bbb9aad02597eef2c61d6d09f4be56756cfe45c5d'],
  ['tbc-lib-js', 'lib/crypto/point.js', 'a262d25b4a46273a7c21a5282b714d611f1ce89686c75383fe6a883f321cae52'],
  ['tbc-lib-js', 'lib/crypto/random.js', 'd72536fff55522e9138a18a3f09a0b011d8addabd3258990d865f3d4ec29fe4c'],
  ['tbc-lib-js', 'lib/crypto/schnorr.js', 'e98c28344450ce1b41253a24293d2fed3dde929accc8cc3c8f12f03f9c9ea42c'],
  ['tbc-lib-js', 'lib/crypto/signature.js', 'c125df5eb3643a8fba245c6c62759b107dee2168580b8ee75417bfbd2725b345'],
  ['tbc-lib-js', 'lib/encoding/base58.js', 'ffff06c89f6d0f30b9428552013860dba538d970969cba9be5acafd34681c4b6'],
  ['tbc-lib-js', 'lib/encoding/base58check.js', '0db4aae7784a2c3494852ee2cb0f2d938dd594259fe6efcfe334b50b9f0d7c52'],
  ['tbc-lib-js', 'lib/encoding/bufferreader.js', '90243797831dcaf8ea81bd782fcdefd2d0d87c787c2453a734615d1632a762d6'],
  ['tbc-lib-js', 'lib/encoding/bufferwriter.js', '55fb2e907df2c965315e0a78c528b0653e6f13acaa588d0a71096050237f0292'],
  ['tbc-lib-js', 'lib/encoding/decode-asm.js', '1c75727ac9b3436abced3a753ae863749c4cf61721afdade82b0051f422a92ac'],
  ['tbc-lib-js', 'lib/encoding/decode-hex.js', '54d4544432761883bb25748e302b42eadeb9e834cf0ce65cd7e20e0ea04328e6'],
  ['tbc-lib-js', 'lib/encoding/decode-script-chunks.js', 'b6cf9813da32890103ecd08ba4c565b3d536285600e4b8157ff045fcdad1fff2'],
  ['tbc-lib-js', 'lib/encoding/encode-hex.js', '97594bfbfac7c8810ecc8c00ce2c7d30a85d0e81f7c5b2ff9041f09498f37c81'],
  ['tbc-lib-js', 'lib/encoding/is-hex.js', 'bdbb989e83d54541470439e8baa933441bcc0a6582ef575d2afdace9049f6e28'],
  ['tbc-lib-js', 'lib/encoding/varint.js', '372a131017ca0f191cf8e1a2f8a1997b32c289b299b71f93c2e09a06ce72940f'],
  ['tbc-lib-js', 'lib/errors/index.js', '7c86c3564fb41a6515746ebb0d5e118d3b2f0a69018c1d7853c8245c1776022e'],
  ['tbc-lib-js', 'lib/errors/spec.js', 'a0bbadbe22eb2d49d36efa91e493c10f0680a662785148185e3cd831c5e6cc62'],
  ['tbc-lib-js', 'lib/hash-cache.js', '0790d3bacc2079094edf9631774bdd7791e617fa76558c3e710d2fef8f051be9'],
  ['tbc-lib-js', 'lib/networks.js', 'f828f6b818d3030b56929bde34b38b389a15576aaaa48e5a25a44d43b0db37a3'],
  ['tbc-lib-js', 'lib/opcode.js', 'fa28081bd76a3064cc19dbc7e7820568e1dab0e8a604e55ba75bdba8596063b1'],
  ['tbc-lib-js', 'lib/privatekey.js', '400a438f18f6626e1138d0cf42f3f0a3874bf49162f4f941580afc335fc45f96'],
  ['tbc-lib-js', 'lib/publickey.js', 'f40e9b80af5acff0c4ef4b9a15cacf88d182c54226c1c0b7be36e0d5b8abbdd6'],
  ['tbc-lib-js', 'lib/script/index.js', 'b0762233b6c2f5449f310df35861c70df5d18456a19bf4a4a146db2c7e73b638'],
  ['tbc-lib-js', 'lib/script/interpreter.js', '38d172b13946b1c30de034a852616f732f80b91dad029aa232f654e6874092eb'],
  ['tbc-lib-js', 'lib/script/script.js', '1af78ec395c8a06b85c9ba1aba32441bfa710a2f016639a97230cc6a298d6552'],
  ['tbc-lib-js', 'lib/script/stack.js', '0308ff54a8cc50a78bde49359a6f613f44f8baec3097eb20f0f04ebfb8e5278d'],
  ['tbc-lib-js', 'lib/script/write-i32-le.js', 'f0c06cda81fa67a2847b66349d9aa751b84e8ec9e31a48f22fc0b8c6d969e23a'],
  ['tbc-lib-js', 'lib/script/write-push-data.js', 'daad2018d6d6d30a2181ee059629fe269ba7c4a18b387c302ef58fcc77fc4c3b'],
  ['tbc-lib-js', 'lib/script/write-u8-le.js', 'c83b0a1a8acbfc5afd1a38ba4838a852ee4957cc3aaa99a022fc6424a9ad16df'],
  ['tbc-lib-js', 'lib/script/write-varint.js', '383e5ac95553e56de158a108f39f47c7b242f49d212ac058b0571e214de2358c'],
  ['tbc-lib-js', 'lib/script/write-u16-le.js', '3ce5f7b433f67e9ef1928d4dc9d1db021f7864f1675ca2b2880e2af6a02a335e'],
  ['tbc-lib-js', 'lib/script/write-u32-le.js', 'b7f41683195fce115d0fa13e0b0fe79b783e242b529d96536e6e52725c7c5a35'],
  ['tbc-lib-js', 'lib/transaction/index.js', '3ff97c4861890b7eb6e7336448be88badd19b155742366bc9ed6deeb12fef6da'],
  ['tbc-lib-js', 'lib/transaction/input/index.js', '9ff44034ee13a5ba57f19e8f297cc2cde6620bae039a16e1fb5ebdd7e5a3603f'],
  ['tbc-lib-js', 'lib/transaction/input/input.js', '7a9b94e59d4dd7fdb8d57bfae24cc93f13879ea7bee5924cc98b0ff82831a153'],
  ['tbc-lib-js', 'lib/transaction/input/multisig.js', 'fa2def4de1bc688609745793601c59cdac27341094e1e36eced7380348ef324a'],
  ['tbc-lib-js', 'lib/transaction/input/multisigscripthash.js', '08accc4a1f4e9161c8a7e56385b5378c617a17f34b0602a246f7263980c8f36e'],
  ['tbc-lib-js', 'lib/transaction/input/publickey.js', 'fd7abaa3a542f77e912a92f294296d8843970c57bb54ce519bfabe5c2251f3ca'],
  ['tbc-lib-js', 'lib/transaction/input/publickeyhash.js', '24699915502250c8f73cc80d68e2d31198c197b1fb9895dc88b9b84359be9616'],
  ['tbc-lib-js', 'lib/transaction/output.js', '116afcad202d474fee41ae35a4f9aea77302c8a9cf34ce568ffe2918cde42929'],
  ['tbc-lib-js', 'lib/transaction/sighash.js', 'd75ca238130044017a187742e5ebc0830985bed945a027ffdb11afec6df18181'],
  ['tbc-lib-js', 'lib/transaction/signature.js', '61ff00ace715175f785028f0f48032e4dddf4cfcedf44cef5f62c1797826a2e9'],
  ['tbc-lib-js', 'lib/transaction/transaction.js', '3e0d282d9ba80d7424edec33126b645ff9fcd6387c0d3baddb469465632a9325'],
  ['tbc-lib-js', 'lib/transaction/unspentoutput.js', 'db9672d88d2e92b138ff8dc055c13b3f1d928ada6066338626a9043966818d71'],
  ['tbc-lib-js', 'lib/util/_.js', '92b83046cd3d75fc0330cd8ef4a953ccbb1e92534d263ffe4fb5124e839620f5'],
  ['tbc-lib-js', 'lib/util/js.js', '7a7859e69947f064d786bb72bb3406c8d7d01862d03a02d350106ba93131dfbf'],
  ['tbc-lib-js', 'lib/util/partial-sha256.js', '484f8dff255eb1799895ef40fa95ef2d48434e94e192265a31ad969eafe7855b'],
  ['tbc-lib-js', 'lib/util/preconditions.js', '89b03f2af08656ee47b6ef59ebfe091e5b93a083b9952e2c8f353fadb196e373'],
  ['elliptic', 'lib/elliptic/utils.js', '3eb8452d1321ec02862fe00a6afa69b12e6ef7d6633108919f1d4f3b069be90b'],
  ['elliptic', 'lib/elliptic/curve/base.js', '14aeb577b6509519d50c2c3f6c17faeef3e29d4fe126c8b60435f547fa76a2f5'],
  ['elliptic', 'lib/elliptic/curve/short.js', 'ff57ccea34340311c170dbfc2d249a261590deda75f8c586e5f3d7d679b79890'],
  ['elliptic', 'lib/elliptic/curves.js', '7b2955d3137649d603d890e25e96d199148a93255e98ea9a495bdb4f1f0ffdf1'],
  ['elliptic', 'lib/elliptic/ec/index.js', '668741c0c921bf5174439104e8fd20636578373cbbd28736ccbcd8e59a5aeafc'],
  ['elliptic', 'lib/elliptic/ec/key.js', '08183de5864bcf40879a9f4fb3f0b3d3b30b557352457c98de8aab2de29396df'],
  ['elliptic', 'lib/elliptic/ec/signature.js', 'e22eb27aa99f94f09f07446779a63ddddcc0023a248ce8040e8acd17ae748e72'],
  ['elliptic', 'lib/elliptic/precomputed/secp256k1.js', '9e383365793650467605de197cdb71e09c22ebcdc02c5336873412c14c81bac7'],
  ['elliptic-inherits', 'inherits.js', 'bb380f32bef5feb18678f0f45f88073fed5d7a0069a309132cb2080cd553d5c7'],
  ['bn.js', 'lib/bn.js', 'e89de863ba8e6708beba85ad616bd4f067481d485ae2334e6d4b574671886dfc'],
  ['brorand', 'index.js', '3deb9a82f06f1add80673ea960f409fb3d456bf9e74192ecfde453f0b56d9ee4'],
  ['hash.js', 'lib/hash.js', '2c2b7f9979522553acf1722b8d046f280a6364a6ceab10323ababf79247830ef'],
  ['hash.js', 'lib/hash/common.js', 'e7f0b5c30a4fd0630cef07f95c54c96375c11a4666c77e5552251d6fa1409ef3'],
  ['hash.js', 'lib/hash/hmac.js', '88f1981433aa7bd1d53628ecec6dcb0dcaf72fba02b839398902dfea14e346ad'],
  ['hash.js', 'lib/hash/ripemd.js', '3f4884df0b5b47b4ba3d8170de1b61b1a0411da3cec3769f6c6eda523ef7e5d4'],
  ['hash.js', 'lib/hash/sha.js', '304f42a7945c5721bae922599e5a6e83fc47fdac08d540a15ad01fffa37ed161'],
  ['hash.js', 'lib/hash/sha/1.js', '122290d248cdb95b0d8e272a7bc0d273cae6cd647a69cd5bca44aa29f1030da4'],
  ['hash.js', 'lib/hash/sha/224.js', 'b9479b26609538edca7a0a8631413fc15ceaf72777c4c2c0048489bd794f9aec'],
  ['hash.js', 'lib/hash/sha/256.js', '1a7ad8ed3c9f3ffa9c40097dcac66eae788c34a1210cbb70c7efbee7c1c07635'],
  ['hash.js', 'lib/hash/sha/384.js', '9e3230ff7f6dfce3f490156dc71bf99b3fa32a3d4c94b0166d13b5f0e2d769ca'],
  ['hash.js', 'lib/hash/sha/512.js', 'bccd07a74dae7a719c9da801da393970bdb7ad999a0a61bf306cad5f400ca63a'],
  ['hash.js', 'lib/hash/sha/common.js', '28c0b8add8bc208930f5f9ca6e30844bc6d7eba06700e4fa04adc79d26807185'],
  ['hash.js', 'lib/hash/utils.js', 'a4ca67e804ab52b5459c9c3e5e966043d53fc519213738d00c1de9e4d4d6a6e1'],
  ['hmac-drbg', 'lib/hmac-drbg.js', '5b89c7d8147fbba4c89d686d8ea08cd350d77eb994bf9a41e3904a3ffe7e6161'],
  ['inherits', 'inherits.js', '7af9a5f76c00f72bed44b83824a8acd67febcfd3d34fd293c20c35aa7e6657f6'],
  ['minimalistic-assert', 'index.js', 'c62009724a28986193befd6b7746ea8f8a96fef1ac64df78fe3e4b05a8ffeeb2'],
  ['minimalistic-crypto-utils', 'lib/utils.js', 'fb5bcdfa3631a0ac40a83911d696ddc4e615f38a2cca560600fc0101479af727'],
  ['bs58', 'index.js', '0cfcec7b298a0c33588b432fad41e2fba216336d34ffd8c13422d21d3134ab57'],
  ['base-x', 'src/index.js', 'eaf1b7363a6a3144f0297786c8dc8ae6b84c2b43e096c0b009ab31d8d599a274'],
  ['safe-buffer', 'index.js', '184d5c4a83512e3f49d4d5b52f7073f601f933bad11f1fbb3ad364ca5e6478e1']
])

const CONTRACT_GIT_PATHS = Object.freeze(
  SOURCE_SPECS.filter(([component]) => component === 'tbc-contract')
    .map(([, relativePath]) => relativePath)
)

function assertInside (candidate, root, label) {
  const relative = path.relative(root, candidate)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must resolve inside ${root}, got ${candidate}`)
  }
}

function sha256File (source) {
  return crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')
}

function assertCleanGitPaths (root, relativePaths) {
  const status = execFileSync(
    'git',
    ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all', '--', ...relativePaths],
    { encoding: 'utf8' }
  ).trim()
  if (status !== '') throw new Error(`dirty authority file(s) in ${root}: ${status.replaceAll('\n', '; ')}`)
}

function fingerprint (component, relativePath, expectedSha256) {
  const root = COMPONENT_ROOTS[component]
  const source = fs.realpathSync(path.join(root, relativePath))
  assertInside(source, root, `${component} source ${relativePath}`)
  const actualSha256 = sha256File(source)
  if (actualSha256 !== expectedSha256) {
    throw new Error(`${component} ${relativePath} SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`)
  }
  return { component, path: relativePath, sha256: actualSha256 }
}

function assertResolution (anchor, request, component, relativePath) {
  const actual = fs.realpathSync(createRequire(anchor).resolve(request))
  const expected = fs.realpathSync(path.join(COMPONENT_ROOTS[component], relativePath))
  if (actual !== expected) throw new Error(`${request} resolved to ${actual}, expected ${expected}`)
}

assertInside(TBC_ROOT, CONTRACT_NODE_MODULES_ROOT, 'tbc-lib-js root')
assertCleanGitPaths(CONTRACT_ROOT, CONTRACT_GIT_PATHS)
const SOURCE_FINGERPRINTS = SOURCE_SPECS.map(spec => fingerprint(...spec))

const POOL_ENTRY = fs.realpathSync(path.join(CONTRACT_ROOT, 'lib/contract/poolNFT2.0.js'))
const FT_ENTRY = fs.realpathSync(path.join(CONTRACT_ROOT, 'lib/contract/ft.js'))
assertResolution(POOL_ENTRY, '../util/poolnftunlock', 'tbc-contract', 'lib/util/poolnftunlock.js')
assertResolution(POOL_ENTRY, '../util/util', 'tbc-contract', 'lib/util/util.js')
assertResolution(FT_ENTRY, '../util/ftunlock', 'tbc-contract', 'lib/util/ftunlock.js')
assertResolution(POOL_ENTRY, 'tbc-lib-js/lib/util/partial-sha256', 'tbc-lib-js', 'lib/util/partial-sha256.js')
assertResolution(path.join(TBC_ROOT, 'lib/address.js'), './crypto/hash', 'tbc-lib-js', 'lib/crypto/hash.js')
assertResolution(path.join(TBC_ROOT, 'lib/encoding/base58.js'), 'bs58', 'bs58', 'index.js')
assertResolution(path.join(COMPONENT_ROOTS.bs58, 'index.js'), 'base-x', 'base-x', 'src/index.js')
assertResolution(path.join(COMPONENT_ROOTS['base-x'], 'src/index.js'), 'safe-buffer', 'safe-buffer', 'index.js')
assertResolution(path.join(COMPONENT_ROOTS.elliptic, 'lib/elliptic/curve/short.js'), 'bn.js', 'bn.js', 'lib/bn.js')
assertResolution(path.join(COMPONENT_ROOTS.elliptic, 'lib/elliptic/curve/short.js'), 'inherits', 'elliptic-inherits', 'inherits.js')
assertResolution(path.join(COMPONENT_ROOTS.elliptic, 'lib/elliptic/utils.js'), 'minimalistic-assert', 'minimalistic-assert', 'index.js')
assertResolution(path.join(COMPONENT_ROOTS.elliptic, 'lib/elliptic/utils.js'), 'minimalistic-crypto-utils', 'minimalistic-crypto-utils', 'lib/utils.js')
assertResolution(path.join(COMPONENT_ROOTS.elliptic, 'lib/elliptic/ec/index.js'), 'hmac-drbg', 'hmac-drbg', 'lib/hmac-drbg.js')
assertResolution(path.join(COMPONENT_ROOTS.elliptic, 'lib/elliptic/ec/index.js'), 'brorand', 'brorand', 'index.js')
assertResolution(path.join(COMPONENT_ROOTS.elliptic, 'lib/elliptic/curves.js'), 'hash.js', 'hash.js', 'lib/hash.js')
assertResolution(path.join(COMPONENT_ROOTS['hash.js'], 'lib/hash/utils.js'), 'inherits', 'inherits', 'inherits.js')

const CONTRACT_PACKAGE = JSON.parse(fs.readFileSync(path.join(CONTRACT_ROOT, 'package.json'), 'utf8'))
const TBC_PACKAGE = JSON.parse(fs.readFileSync(path.join(TBC_ROOT, 'package.json'), 'utf8'))
if (CONTRACT_PACKAGE.name !== 'tbc-contract' || CONTRACT_PACKAGE.version !== '1.6.5') {
  throw new Error(`expected tbc-contract 1.6.5 at ${CONTRACT_ROOT}, got ${CONTRACT_PACKAGE.name} ${CONTRACT_PACKAGE.version}`)
}
if (TBC_PACKAGE.name !== 'tbc-lib-js' || TBC_PACKAGE.version !== '1.0.31') {
  throw new Error(`expected tbc-lib-js 1.0.31 at ${TBC_ROOT}, got ${TBC_PACKAGE.name} ${TBC_PACKAGE.version}`)
}

const TBC_ADDRESS_ENTRY = fs.realpathSync(path.join(TBC_ROOT, 'lib/address.js'))
const TBC_POINT_ENTRY = fs.realpathSync(path.join(TBC_ROOT, 'lib/crypto/point.js'))
const TBC_CRYPTO_ROOT = fs.realpathSync(path.join(TBC_ROOT, 'lib/crypto'))
const TBC_TRANSACTION_ROOT = fs.realpathSync(path.join(TBC_ROOT, 'lib/transaction'))
const ELLIPTIC_CURVES_ENTRY = fs.realpathSync(path.join(COMPONENT_ROOTS.elliptic, 'lib/elliptic/curves.js'))
const ELLIPTIC_EC_ENTRY = fs.realpathSync(path.join(COMPONENT_ROOTS.elliptic, 'lib/elliptic/ec/index.js'))
const ELLIPTIC_SHORT_ENTRY = fs.realpathSync(path.join(COMPONENT_ROOTS.elliptic, 'lib/elliptic/curve/short.js'))
const PINNED_AUTHORITY_FILES = new Set(
  SOURCE_SPECS.map(([component, relativePath]) =>
    fs.realpathSync(path.join(COMPONENT_ROOTS[component], relativePath))
  )
)

let Script
let tbc
let ellipticFacade
let FT
let PoolNFT2
const originalModuleLoad = Module._load
try {
  const directCurveFacade = Object.freeze({
    short: require(ELLIPTIC_SHORT_ENTRY)
  })
  Module._load = function loadPoolV2AuthorityDependency (request, parent, isMain) {
    if (request === './curve' && parent && parent.filename === ELLIPTIC_CURVES_ENTRY) {
      return directCurveFacade
    }
    if (
      request === 'elliptic' &&
      parent &&
      (parent.filename === TBC_POINT_ENTRY || parent.filename.startsWith(`${TBC_CRYPTO_ROOT}${path.sep}`))
    ) {
      return ellipticFacade
    }
    if (request === './script' && parent && parent.filename === TBC_ADDRESS_ENTRY) {
      return Script
    }
    if (
      (request === '../script' || request === '../../script') &&
      parent &&
      parent.filename.startsWith(`${TBC_TRANSACTION_ROOT}${path.sep}`)
    ) {
      return Script
    }
    if (request === '../api/api' && parent && parent.filename === POOL_ENTRY) {
      return Object.freeze({})
    }
    if (request === 'tbc-lib-js' && parent && parent.filename.startsWith(`${CONTRACT_ROOT}${path.sep}`)) {
      return tbc
    }
    return originalModuleLoad.call(this, request, parent, isMain)
  }

  ellipticFacade = Object.freeze({ ec: require(ELLIPTIC_EC_ENTRY) })
  Script = require(path.join(TBC_ROOT, 'lib/script/script.js'))
  tbc = {
    Address: require(TBC_ADDRESS_ENTRY),
    PrivateKey: require(path.join(TBC_ROOT, 'lib/privatekey.js')),
    PublicKey: require(path.join(TBC_ROOT, 'lib/publickey.js')),
    Script,
    crypto: {
      BN: require(path.join(TBC_ROOT, 'lib/crypto/bn.js')),
      Hash: require(path.join(TBC_ROOT, 'lib/crypto/hash.js'))
    },
    encoding: {
      BufferWriter: require(path.join(TBC_ROOT, 'lib/encoding/bufferwriter.js'))
    }
  }
  tbc.Transaction = require(path.join(TBC_ROOT, 'lib/transaction/index.js'))

  FT = require(FT_ENTRY)
  PoolNFT2 = require(POOL_ENTRY)
} finally {
  Module._load = originalModuleLoad
}

function assertLoadedAuthorityClosure () {
  const unpinned = Object.keys(require.cache)
    .filter(filename => filename.startsWith(`${CONTRACT_ROOT}${path.sep}`))
    .filter(filename => !PINNED_AUTHORITY_FILES.has(fs.realpathSync(filename)))
  if (unpinned.length !== 0) {
    throw new Error(`unpinned loaded fixture authority module(s): ${unpinned.join(', ')}`)
  }
}

module.exports = {
  assertCleanGitPaths,
  assertLoadedAuthorityClosure,
  CONTRACT_GIT_PATHS,
  CONTRACT_PACKAGE,
  CONTRACT_ROOT,
  DEPENDENCY_HELPER_PATH: fs.realpathSync(__filename),
  PoolNFT2,
  SDK_ROOT,
  SOURCE_FINGERPRINTS,
  TBC_PACKAGE,
  TBC_ROOT,
  FT,
  sha256File,
  tbc
}
