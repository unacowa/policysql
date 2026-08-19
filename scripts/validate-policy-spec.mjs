import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { parse as parseYaml } from 'yaml'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ajv = new Ajv2020({ allErrors: true, strict: true })
const policySchemaPath = path.join(root, 'spec/schemas/policy.schema.json')
const policyFixtureRoot = path.join(root, 'spec/fixtures/policy-nullable')
const authSchemaPath = path.join(root, 'spec/schemas/jwt-claims.schema.json')
const authFixtureRoot = path.join(root, 'spec/fixtures/auth')
const catalogSchemaPath = path.join(root, 'spec/schemas/catalog.schema.json')
const catalogFixtureRoot = path.join(root, 'spec/fixtures/catalog')
const catalogManifestSchemaPath = path.join(root, 'spec/schemas/catalog-manifest.schema.json')
const catalogManifestFixtureRoot = path.join(root, 'spec/fixtures/catalog-manifest')
const atomicExecuteSchemaPath = path.join(root, 'spec/schemas/atomic-execute.schema.json')
const atomicExecuteFixtureRoot = path.join(root, 'spec/fixtures/atomic-execute')
const sqlSurfaceSchemaPath = path.join(root, 'tests/schemas/sql-surface.schema.json')
const fixtureCaseSchemaPath = path.join(root, 'tests/schemas/fixture-case.schema.json')
const sqlSurfaceRoot = path.join(root, 'tests/sql-surface')
const compilerFixtureRoot = path.join(root, 'tests/fixtures')
const validatePolicySchema = ajv.compile(JSON.parse(fs.readFileSync(policySchemaPath, 'utf8')))
const validateAuthSchema = ajv.compile(JSON.parse(fs.readFileSync(authSchemaPath, 'utf8')))
const validateCatalogSchema = ajv.compile(JSON.parse(fs.readFileSync(catalogSchemaPath, 'utf8')))
const validateCatalogManifestSchema = ajv.compile(JSON.parse(fs.readFileSync(catalogManifestSchemaPath, 'utf8')))
const validateAtomicExecuteSchema = ajv.compile(JSON.parse(fs.readFileSync(atomicExecuteSchemaPath, 'utf8')))
const validateSqlSurfaceSchema = ajv.compile(JSON.parse(fs.readFileSync(sqlSurfaceSchemaPath, 'utf8')))
const validateFixtureCaseSchema = ajv.compile(JSON.parse(fs.readFileSync(fixtureCaseSchemaPath, 'utf8')))
const openApiPath = path.join(root, 'spec/openapi.yaml')

function markdownFiles(entryPath) {
  const stat = fs.statSync(entryPath)
  if (stat.isFile()) return entryPath.endsWith('.md') ? [entryPath] : []
  return fs.readdirSync(entryPath, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && ['node_modules', 'dist', '.vitepress'].includes(entry.name)) return []
    return markdownFiles(path.join(entryPath, entry.name))
  })
}

function filesNamed(entryPath, name) {
  const stat = fs.statSync(entryPath)
  if (stat.isFile()) return path.basename(entryPath) === name ? [entryPath] : []
  return fs.readdirSync(entryPath, { withFileTypes: true }).flatMap((entry) =>
    filesNamed(path.join(entryPath, entry.name), name),
  )
}

function filesWithExtension(entryPath, extension) {
  const stat = fs.statSync(entryPath)
  if (stat.isFile()) return path.extname(entryPath) === extension ? [entryPath] : []
  return fs.readdirSync(entryPath, { withFileTypes: true }).flatMap((entry) =>
    filesWithExtension(path.join(entryPath, entry.name), extension),
  )
}

function readYaml(filePath) {
  return parseYaml(fs.readFileSync(filePath, 'utf8'), { uniqueKeys: true })
}

function operationScopes(document) {
  const scopes = []
  for (const [role, policy] of Object.entries(document.roles ?? {})) {
    if (policy.select) scopes.push([`${role}.select`, policy.select])
    for (const operation of ['insert', 'update', 'delete']) {
      const returning = policy[operation]?.returning
      if (returning) scopes.push([`${role}.${operation}.returning`, returning])
    }
  }
  return scopes
}

function outputColumnName(column) {
  return typeof column === 'string' ? column : column.name
}

function semanticErrors(document) {
  const errors = []
  for (const include of document.includes ?? []) {
    const normalized = path.posix.normalize(include)
    if (
      path.posix.isAbsolute(include)
      || include.includes('\\')
      || normalized === '..'
      || normalized.startsWith('../')
      || /[*?{}$]/.test(include)
      || /^[a-z][a-z0-9+.-]*:/i.test(include)
    ) {
      errors.push(`invalid include path: ${include}`)
    }
  }
  for (const [scope, value] of operationScopes(document)) {
    const names = new Set()
    for (const column of value.columns ?? []) {
      const name = outputColumnName(column)
      if (names.has(name)) errors.push(`${scope}: duplicate output column ${name}`)
      names.add(name)
    }
  }
  for (const [role, policy] of Object.entries(document.roles ?? {})) {
    for (const operation of ['insert', 'update']) {
      const value = policy[operation]
      if (!value) continue
      const clientColumns = new Set(value.columns ?? [])
      for (const column of Object.keys(value.presets ?? {})) {
        if (clientColumns.has(column)) {
          errors.push(`${role}.${operation}: ${column} appears in columns and presets`)
        }
      }
    }
  }
  return errors
}

function validateDocument(filePath) {
  const document = readYaml(filePath)
  const schemaValid = validatePolicySchema(document)
  const errors = []
  if (!schemaValid) {
    errors.push(...(validatePolicySchema.errors ?? []).map((error) => `${error.instancePath} ${error.message}`))
  }
  errors.push(...semanticErrors(document))
  return errors
}

let failures = 0
let policyFixtureCount = 0

for (const name of fs.readdirSync(path.join(policyFixtureRoot, 'valid')).sort()) {
  policyFixtureCount += 1
  const filePath = path.join(policyFixtureRoot, 'valid', name)
  const errors = validateDocument(filePath)
  if (errors.length > 0) {
    failures += 1
    console.error(`expected valid: ${name}\n  ${errors.join('\n  ')}`)
  }
}

for (const name of fs.readdirSync(path.join(policyFixtureRoot, 'invalid')).sort()) {
  policyFixtureCount += 1
  const filePath = path.join(policyFixtureRoot, 'invalid', name)
  const errors = validateDocument(filePath)
  if (errors.length === 0) {
    failures += 1
    console.error(`expected invalid: ${name}`)
  }
}

const sqlCases = JSON.parse(fs.readFileSync(path.join(policyFixtureRoot, 'sql-cases.json'), 'utf8'))
const caseNames = new Set()
for (const fixture of sqlCases) {
  if (!fixture.name || !fixture.sql || !['allow', 'deny'].includes(fixture.expected)) {
    failures += 1
    console.error('invalid SQL contract fixture')
    continue
  }
  if (caseNames.has(fixture.name)) {
    failures += 1
    console.error(`duplicate SQL fixture name: ${fixture.name}`)
  }
  caseNames.add(fixture.name)
  if (fixture.expected === 'deny' && !fixture.error) {
    failures += 1
    console.error(`denied fixture has no error code: ${fixture.name}`)
  }
}

let authFixtureCount = 0

function authSemanticErrors(document) {
  const errors = []
  if (!document.policysql?.roles?.includes(document.policysql?.default_role)) {
    errors.push('policysql.default_role must be present in policysql.roles')
  }
  if (document.exp <= document.iat) {
    errors.push('exp must be greater than iat')
  }
  return errors
}

for (const expected of ['valid', 'invalid']) {
  for (const name of fs.readdirSync(path.join(authFixtureRoot, expected)).sort()) {
    authFixtureCount += 1
    const document = JSON.parse(fs.readFileSync(path.join(authFixtureRoot, expected, name), 'utf8'))
    const valid = validateAuthSchema(document)
    const errors = valid
      ? authSemanticErrors(document)
      : (validateAuthSchema.errors ?? []).map((error) => `${error.instancePath} ${error.message}`)
    if (expected === 'valid' && errors.length > 0) {
      failures += 1
      console.error(`expected valid auth fixture: ${name}\n  ${errors.join('\n  ')}`)
    }
    if (expected === 'invalid' && errors.length === 0) {
      failures += 1
      console.error(`expected invalid auth fixture: ${name}`)
    }
  }
}

function duplicateNames(values) {
  const seen = new Set()
  const duplicates = []
  for (const value of values) {
    const key = value.name.toLowerCase()
    if (seen.has(key)) duplicates.push(value.name)
    seen.add(key)
  }
  return duplicates
}

function catalogSemanticErrors(document) {
  const errors = duplicateNames(document.resources ?? []).map((name) => `duplicate resource: ${name}`)
  for (const resource of document.resources ?? []) {
    for (const [operation, contract] of Object.entries(resource.operations ?? {})) {
      for (const name of duplicateNames(contract.columns ?? [])) {
        errors.push(`${resource.name}.${operation}: duplicate column ${name}`)
      }
      for (const column of contract.columns ?? []) {
        if (column.nullableOnDenied && (column.usage.length !== 1 || column.usage[0] !== 'projection')) {
          errors.push(`${resource.name}.${operation}.${column.name}: nullableOnDenied requires projection-only usage`)
        }
        if (operation === 'select' && !contract.allowAggregations && column.usage.some((item) => ['group', 'aggregate'].includes(item))) {
          errors.push(`${resource.name}.${operation}.${column.name}: aggregate usage requires allowAggregations`)
        }
        if (operation === 'select' && !contract.allowWindows && column.usage.includes('window')) {
          errors.push(`${resource.name}.${operation}.${column.name}: window usage requires allowWindows`)
        }
      }
      for (const name of duplicateNames(contract.returning?.columns ?? [])) {
        errors.push(`${resource.name}.${operation}.returning: duplicate column ${name}`)
      }
    }
  }
  return errors
}

let catalogFixtureCount = 0
for (const expected of ['valid', 'invalid']) {
  for (const name of fs.readdirSync(path.join(catalogFixtureRoot, expected)).sort()) {
    catalogFixtureCount += 1
    const document = JSON.parse(fs.readFileSync(path.join(catalogFixtureRoot, expected, name), 'utf8'))
    const valid = validateCatalogSchema(document)
    const errors = valid
      ? catalogSemanticErrors(document)
      : (validateCatalogSchema.errors ?? []).map((error) => `${error.instancePath} ${error.message}`)
    if (expected === 'valid' && errors.length > 0) {
      failures += 1
      console.error(`expected valid catalog fixture: ${name}\n  ${errors.join('\n  ')}`)
    }
    if (expected === 'invalid' && errors.length === 0) {
      failures += 1
      console.error(`expected invalid catalog fixture: ${name}`)
    }
  }
}

let catalogManifestFixtureCount = 0
for (const expected of ['valid', 'invalid']) {
  for (const name of fs.readdirSync(path.join(catalogManifestFixtureRoot, expected)).sort()) {
    catalogManifestFixtureCount += 1
    const document = readYaml(path.join(catalogManifestFixtureRoot, expected, name))
    const valid = validateCatalogManifestSchema(document)
    const errors = valid
      ? []
      : (validateCatalogManifestSchema.errors ?? []).map((error) => `${error.instancePath} ${error.message}`)
    if (expected === 'valid' && errors.length > 0) {
      failures += 1
      console.error(`expected valid catalog manifest fixture: ${name}\n  ${errors.join('\n  ')}`)
    }
    if (expected === 'invalid' && errors.length === 0) {
      failures += 1
      console.error(`expected invalid catalog manifest fixture: ${name}`)
    }
  }
}

let atomicExecuteFixtureCount = 0
for (const expected of ['valid', 'invalid']) {
  for (const name of fs.readdirSync(path.join(atomicExecuteFixtureRoot, expected)).sort()) {
    atomicExecuteFixtureCount += 1
    const document = JSON.parse(fs.readFileSync(path.join(atomicExecuteFixtureRoot, expected, name), 'utf8'))
    const valid = validateAtomicExecuteSchema(document)
    if (expected === 'valid' && !valid) {
      failures += 1
      const errors = (validateAtomicExecuteSchema.errors ?? []).map((error) => `${error.instancePath} ${error.message}`)
      console.error(`expected valid atomic execute fixture: ${name}\n  ${errors.join('\n  ')}`)
    }
    if (expected === 'invalid' && valid) {
      failures += 1
      console.error(`expected invalid atomic execute fixture: ${name}`)
    }
  }
}

let sqlSurfaceDocumentCount = 0
for (const filePath of filesWithExtension(sqlSurfaceRoot, '.yaml')) {
  sqlSurfaceDocumentCount += 1
  const document = readYaml(filePath)
  if (!validateSqlSurfaceSchema(document)) {
    failures += 1
    const errors = (validateSqlSurfaceSchema.errors ?? []).map((error) => `${error.instancePath} ${error.message}`)
    console.error(`invalid SQL surface document ${path.relative(root, filePath)}:\n  ${errors.join('\n  ')}`)
  }
}

let compilerFixtureCount = 0
for (const filePath of filesNamed(compilerFixtureRoot, 'case.yaml')) {
  compilerFixtureCount += 1
  const document = readYaml(filePath)
  if (!validateFixtureCaseSchema(document)) {
    failures += 1
    const errors = (validateFixtureCaseSchema.errors ?? []).map((error) => `${error.instancePath} ${error.message}`)
    console.error(`invalid compiler fixture ${path.relative(root, filePath)}:\n  ${errors.join('\n  ')}`)
  }
}

const openApi = readYaml(openApiPath)
const operationIds = new Set()

function resolveJsonPointer(document, pointer) {
  return pointer
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, part) => value?.[part], document)
}

function validateOpenApiNode(value) {
  if (Array.isArray(value)) {
    for (const item of value) validateOpenApiNode(item)
    return
  }
  if (!value || typeof value !== 'object') return
  if (typeof value.$ref === 'string') {
    if (value.$ref.startsWith('#/')) {
      if (resolveJsonPointer(openApi, value.$ref) === undefined) {
        failures += 1
        console.error(`unresolved OpenAPI reference: ${value.$ref}`)
      }
    } else {
      const externalPath = path.resolve(path.dirname(openApiPath), value.$ref)
      if (!fs.existsSync(externalPath)) {
        failures += 1
        console.error(`missing OpenAPI external reference: ${value.$ref}`)
      }
    }
  }
  for (const child of Object.values(value)) validateOpenApiNode(child)
}

if (openApi.openapi !== '3.1.0') {
  failures += 1
  console.error('OpenAPI document must use version 3.1.0')
}
for (const pathItem of [...Object.values(openApi.paths ?? {}), ...Object.values(openApi.webhooks ?? {})]) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const operation = pathItem[method]
    if (!operation) continue
    if (!operation.operationId || operationIds.has(operation.operationId)) {
      failures += 1
      console.error(`missing or duplicate OpenAPI operationId: ${operation.operationId ?? '<missing>'}`)
    }
    operationIds.add(operation.operationId)
  }
}
validateOpenApiNode(openApi)

let documentationJsonCount = 0
let documentationYamlCount = 0
for (const filePath of [
  path.join(root, 'README.md'),
  ...markdownFiles(path.join(root, 'docs')),
  ...markdownFiles(path.join(root, 'website')),
]) {
  const source = fs.readFileSync(filePath, 'utf8')
  for (const match of source.matchAll(/```(json|ya?ml)\n([\s\S]*?)```/g)) {
    try {
      if (match[1] === 'json') {
        const document = JSON.parse(match[2])
        documentationJsonCount += 1
        if (
          Array.isArray(document.statements)
          && document.statements.some((statement) => typeof statement?.sql === 'string')
          && !validateAtomicExecuteSchema(document)
        ) {
          const errors = (validateAtomicExecuteSchema.errors ?? []).map((error) => `${error.instancePath} ${error.message}`)
          throw new Error(`invalid Atomic Execute example: ${errors.join('; ')}`)
        }
      } else {
        parseYaml(match[2], { uniqueKeys: true })
        documentationYamlCount += 1
      }
    } catch (error) {
      failures += 1
      console.error(`invalid ${match[1]} documentation block in ${path.relative(root, filePath)}: ${error.message}`)
    }
  }
}

if (failures > 0) process.exitCode = 1
else console.log(`validated 7 schemas, OpenAPI (${operationIds.size} operations), ${policyFixtureCount} policy fixtures, ${sqlCases.length} SQL contract fixtures, ${authFixtureCount} auth fixtures, ${catalogFixtureCount} catalog fixtures, ${catalogManifestFixtureCount} catalog manifest fixtures, ${atomicExecuteFixtureCount} atomic execute fixtures, ${sqlSurfaceDocumentCount} SQL surface documents, ${compilerFixtureCount} compiler fixture pairs, and ${documentationJsonCount} JSON/${documentationYamlCount} YAML documentation blocks`)
