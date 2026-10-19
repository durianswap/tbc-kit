'use strict'

const fs = require('fs')
const path = require('path')

const EXPECTED_CONTRACT_ROOT = '/home/ubuntu/projects/tbc-contract'
const CONTRACT_ROOT = fs.realpathSync(EXPECTED_CONTRACT_ROOT)
const CONTRACT_NODE_MODULES_ROOT = fs.realpathSync(path.join(CONTRACT_ROOT, 'node_modules'))
const TBC_ROOT = fs.realpathSync(path.join(CONTRACT_NODE_MODULES_ROOT, 'tbc-lib-js'))

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

assertInside(TBC_ROOT, CONTRACT_NODE_MODULES_ROOT, 'tbc-lib-js root')

const CONTRACT_ENTRY = fs.realpathSync(require.resolve(CONTRACT_ROOT))
const CONTRACT_PACKAGE_PATH = fs.realpathSync(path.join(CONTRACT_ROOT, 'package.json'))
const TBC_ENTRY = fs.realpathSync(require.resolve(TBC_ROOT))
const TBC_PACKAGE_PATH = fs.realpathSync(path.join(TBC_ROOT, 'package.json'))
const INTERPRETER_ENTRY = fs.realpathSync(path.join(TBC_ROOT, 'lib/script/interpreter.js'))
const MULTISIG_ENTRY = fs.realpathSync(path.join(CONTRACT_ROOT, 'lib/contract/multiSig.js'))

assertInside(CONTRACT_ENTRY, CONTRACT_ROOT, 'tbc-contract entry')
assertInside(CONTRACT_PACKAGE_PATH, CONTRACT_ROOT, 'tbc-contract package')
assertInside(TBC_ENTRY, TBC_ROOT, 'tbc-lib-js entry')
assertInside(TBC_PACKAGE_PATH, TBC_ROOT, 'tbc-lib-js package')
assertInside(INTERPRETER_ENTRY, TBC_ROOT, 'tbc-lib-js interpreter')
assertInside(MULTISIG_ENTRY, CONTRACT_ROOT, 'tbc-contract MultiSig module')

const CONTRACT_PACKAGE = require(CONTRACT_PACKAGE_PATH)
if (CONTRACT_PACKAGE.name !== 'tbc-contract' || CONTRACT_PACKAGE.version !== '1.6.5') {
  throw new Error(
    `expected tbc-contract 1.6.5 at ${CONTRACT_ROOT}, got ${CONTRACT_PACKAGE.name} ${CONTRACT_PACKAGE.version}`
  )
}

const TBC_PACKAGE = require(TBC_PACKAGE_PATH)
if (TBC_PACKAGE.name !== 'tbc-lib-js' || TBC_PACKAGE.version !== '1.0.31') {
  throw new Error(
    `expected tbc-lib-js 1.0.31 at ${TBC_ROOT}, got ${TBC_PACKAGE.name} ${TBC_PACKAGE.version}`
  )
}

const CONTRACT_RESOLVED_TBC_ENTRY = fs.realpathSync(
  require.resolve('tbc-lib-js', { paths: [path.dirname(MULTISIG_ENTRY)] })
)
if (CONTRACT_RESOLVED_TBC_ENTRY !== TBC_ENTRY) {
  throw new Error(
    `tbc-contract resolves a different tbc-lib-js instance: ${CONTRACT_RESOLVED_TBC_ENTRY}`
  )
}

const tbc = require(TBC_ENTRY)
const contract = require(CONTRACT_ENTRY)
const Interpreter = require(INTERPRETER_ENTRY)

module.exports = {
  CONTRACT_ENTRY,
  CONTRACT_PACKAGE,
  CONTRACT_ROOT,
  INTERPRETER_ENTRY,
  Interpreter,
  TBC_ENTRY,
  TBC_PACKAGE,
  TBC_ROOT,
  contract,
  tbc
}
